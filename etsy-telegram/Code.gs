/**
 * Etsy → Telegram
 * Каждые 5 минут ищет в Gmail письма «You made a sale on Etsy»
 * и отправляет заказ в группу Telegram.
 *
 * Настройка (один раз):
 *   1. Настройки проекта ⚙️ → «Свойства скрипта» → добавить:
 *        TELEGRAM_BOT_TOKEN = токен от @BotFather
 *        TELEGRAM_CHAT_ID   = id группы (узнать функцией getChatId)
 *   2. Запустить функцию setup — она создаст расписание и пришлёт тест в группу.
 */

const QUERY = 'subject:"You made a sale on Etsy" newer_than:3d';
const LABEL_NAME = 'Etsy/Отправлено в TG';

// ───────────────────────────── запуск ─────────────────────────────

/** Разовая настройка: метка, расписание, старые письма помечаются как отправленные. */
function setup() {
  getProp_('TELEGRAM_BOT_TOKEN');
  getProp_('TELEGRAM_CHAT_ID');
  const label = getLabel_();

  // Старые заказы в группу не шлём — только помечаем
  const old = GmailApp.search('subject:"You made a sale on Etsy"', 0, 200);
  old.forEach(t => t.addLabel(label));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkNewOrders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkNewOrders').timeBased().everyMinutes(5).create();

  sendTelegram_('✅ Бот подключён. Новые заказы Etsy будут приходить сюда.');
  Logger.log('Готово. Старых писем помечено: ' + old.length + '. Проверка каждые 5 минут.');
}

/** Основная функция — её запускает расписание. */
function checkNewOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const label = getLabel_();
    const threads = GmailApp.search(QUERY, 0, 50).filter(
      t => !t.getLabels().some(l => l.getName() === LABEL_NAME));

    // от старых к новым
    threads.reverse().forEach(thread => {
      thread.getMessages().forEach(msg => {
        if (!/You made a sale on Etsy/i.test(msg.getSubject())) return;
        const order = parseOrder_(msg.getSubject(), msg.getBody());
        sendTelegram_(formatOrder_(order));
        Utilities.sleep(500);
      });
      thread.addLabel(label);
    });
  } finally {
    lock.releaseLock();
  }
}

/** Тест: отправить в группу последний заказ (даже если он уже отправлялся). */
function testLastOrder() {
  const threads = GmailApp.search('subject:"You made a sale on Etsy"', 0, 1);
  if (!threads.length) throw new Error('Писем «You made a sale on Etsy» не найдено');
  const msgs = threads[0].getMessages();
  const msg = msgs[msgs.length - 1];
  sendTelegram_(formatOrder_(parseOrder_(msg.getSubject(), msg.getBody())));
  Logger.log('Отправлен заказ: ' + msg.getSubject());
}

/** Показывает id чатов, где писали боту. Сначала напишите что-нибудь в группе. */
function getChatId() {
  const token = getProp_('TELEGRAM_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates',
    { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const chats = {};
  (data.result || []).forEach(u => {
    const m = u.message || u.channel_post || u.my_chat_member || {};
    if (m.chat) chats[m.chat.id] = m.chat.title || m.chat.username || m.chat.first_name;
  });
  const ids = Object.keys(chats);
  if (!ids.length) {
    Logger.log('Сообщений нет. Добавьте бота в группу, напишите там /start и запустите ещё раз.');
    return;
  }
  ids.forEach(id => Logger.log('TELEGRAM_CHAT_ID = ' + id + '   (' + chats[id] + ')'));
}

// ───────────────────────────── разбор письма ─────────────────────────────

function parseOrder_(subject, html) {
  const o = { items: [] };

  // Тема: You made a sale on Etsy - Ship by Nov 25 - [€21,90, Order #4236106400]
  let m = subject.match(/Ship by ([^-\[]+)/i);
  if (m) o.shipBy = m[1].trim();
  m = subject.match(/\[(.+?),\s*Order #(\d+)\]/i);
  if (m) { o.total = m[1].trim(); o.orderId = m[2]; }

  // Адрес
  m = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (m) {
    const lines = toText_(m[1]).split('\n').map(s => s.trim()).filter(Boolean);
    o.name = lines.shift();
    o.address = lines.join('\n');
  }

  // Товары: ссылка на transaction с текстом = название товара
  const re = /<a[^>]+href="https?:\/\/www\.etsy\.com\/transaction\/(\d+)[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/gi;
  const found = [];
  while ((m = re.exec(html)) !== null) {
    found.push({ id: m[1], title: decode_(m[2]), start: m.index, end: re.lastIndex });
  }
  const totalPos = html.search(/Order total/i);
  found.forEach((it, i) => {
    const stop = i + 1 < found.length ? found[i + 1].start : (totalPos > 0 ? totalPos : html.length);
    const block = html.slice(it.end, stop);
    const vars = [];
    const vr = /white-space:\s*pre-wrap;?"[^>]*>([\s\S]*?)<\/div>/gi;
    let v;
    while ((v = vr.exec(block)) !== null) {
      const t = toText_(v[1]).trim().replace(/\s*::\s*/g, ': ');
      if (t) vars.push(t);
    }
    const text = toText_(block);
    const q = text.match(/Quantity:\s*(\d+)/i);
    const p = text.match(/Price:\s*([^\n]+)/i);
    o.items.push({
      title: it.title,
      variations: vars,
      quantity: q ? +q[1] : 1,
      price: p ? p[1].trim() : '',
    });
  });

  // Итоги и примечания — по тексту письма
  const text = toText_(html);
  const after = label => {
    const r = new RegExp(label + ':?\\s*\\n?\\s*([^\\n]+)', 'i');
    const x = text.match(r);
    return x ? x[1].trim() : '';
  };
  o.discount = after('Discount');
  o.shipping = after('Shipping(?! address| internationally)');
  if (!o.total) o.total = after('Order total');
  m = text.match(/applied these discounts:\s*([^\n]+)/i);
  if (m) o.coupons = Array.from(new Set(m[1].split(',').map(s => s.trim()).filter(Boolean))).join(', ');
  m = text.match(/(?:Note|Message) from[^\n]*\n+([\s\S]*?)\n\s*\n/i);
  if (m) o.note = m[1].trim();
  m = text.match(/Gift message[^\n]*\n+([\s\S]*?)\n\s*\n/i);
  if (m) o.gift = m[1].trim();
  if (!o.orderId) {
    m = text.match(/order number is:?\s*(\d+)/i);
    if (m) o.orderId = m[1];
  }
  return o;
}

function formatOrder_(o) {
  const L = [];
  L.push('🛍 <b>Новый заказ #' + esc_(o.orderId || '?') + '</b>');
  if (o.shipBy) L.push('📦 Отправить до: <b>' + esc_(ruDate_(o.shipBy)) + '</b>');
  L.push('');

  o.items.forEach((it, i) => {
    const qty = it.quantity > 1 ? ' × <b>' + it.quantity + ' шт. ‼️</b>' : ' × 1';
    L.push('<b>' + (i + 1) + '. ' + esc_(it.title) + '</b>' + qty);
    it.variations.forEach(v => {
      const pm = v.match(/^Personali[sz]ation:\s*([\s\S]*)/i);
      L.push(pm ? '   ✏️ <b>Персонализация:</b> ' + esc_(pm[1]) : '   • ' + esc_(v));
    });
    if (it.price) L.push('   ' + esc_(it.price));
    L.push('');
  });

  if (o.note) L.push('💬 <b>Сообщение покупателя:</b> <i>' + esc_(o.note) + '</i>', '');
  if (o.gift) L.push('🎁 <b>Подарок:</b> <i>' + esc_(o.gift) + '</i>', '');

  if (o.name) L.push('👤 ' + esc_(o.name));
  if (o.address) L.push('📍 <code>' + esc_(o.address) + '</code>');
  L.push('');

  let money = '💰 <b>' + esc_(o.total || '—') + '</b>';
  const extra = [];
  if (o.shipping) extra.push('доставка ' + o.shipping);
  if (o.discount && !/^-?\s*\D*0[,.]00$/.test(o.discount)) {
    extra.push('скидка ' + o.discount.replace(/^-\s*/, '−') + (o.coupons ? ' (' + o.coupons + ')' : ''));
  }
  if (extra.length) money += ' · ' + esc_(extra.join(' · '));
  L.push(money);

  if (o.orderId) {
    L.push('🔗 <a href="https://www.etsy.com/your/orders/sold?order_id=' + o.orderId +
      '">Открыть заказ на Etsy</a>');
  }
  let msg = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n…';
  return msg;
}

// ───────────────────────────── утилиты ─────────────────────────────

function sendTelegram_(text) {
  const token = getProp_('TELEGRAM_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: {
      chat_id: getProp_('TELEGRAM_CHAT_ID'),
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: 'true',
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Telegram ответил ' + res.getResponseCode() + ': ' + res.getContentText());
  }
}

function getProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Не задано свойство скрипта ' + name + ' (Настройки проекта → Свойства скрипта)');
  return v.trim();
}

function getLabel_() {
  return GmailApp.getUserLabelByName(LABEL_NAME) || GmailApp.createLabel(LABEL_NAME);
}

function toText_(html) {
  return decode_(html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li|table|address)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function decode_(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&euro;/g, '€').replace(/&pound;/g, '£')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ruDate_(s) {
  const months = { jan: 'янв', feb: 'фев', mar: 'мар', apr: 'апр', may: 'мая', jun: 'июн',
    jul: 'июл', aug: 'авг', sep: 'сен', oct: 'окт', nov: 'ноя', dec: 'дек' };
  const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/);
  return m && months[m[1].toLowerCase()] ? m[2] + ' ' + months[m[1].toLowerCase()] : s;
}
