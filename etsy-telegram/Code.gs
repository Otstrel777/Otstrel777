/**
 * Etsy → Telegram
 * Каждые 5 минут ищет в Gmail письма «You made a sale on Etsy»
 * и отправляет заказ в группу Telegram.
 * Раз в день присылает сводку: какие заказы просрочены (нет реакции 👍 после срока отправки).
 *
 * Настройка (один раз):
 *   1. Настройки проекта ⚙️ → «Свойства скрипта» → добавить:
 *        TELEGRAM_BOT_TOKEN = токен от @BotFather
 *        TELEGRAM_CHAT_ID   = id группы (узнать функцией getChatId)
 *   2. Сделать бота администратором группы (нужно, чтобы он видел реакции 👍).
 *   3. Запустить функцию setup — она создаст расписание и пришлёт тест в группу.
 */

const QUERY = 'subject:"You made a sale on Etsy" newer_than:3d';
const LABEL_NAME = 'Etsy/Отправлено в TG';
const START_NUMBER = 1086;  // с какого номера начинать нумерацию заказов
const DONE_EMOJI = '👍';    // реакция «заказ отправлен»
const SUMMARY_HOUR = 9;     // во сколько присылать сводку (час, по часовому поясу проекта)

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
    .filter(t => ['checkNewOrders', 'dailySummary'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkNewOrders').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(SUMMARY_HOUR).create();

  sendTelegram_('✅ Бот подключён. Новые заказы Etsy будут приходить сюда.\n' +
    'Отправленный заказ отмечайте реакцией ' + DONE_EMOJI + '. Каждый день около ' +
    SUMMARY_HOUR + ':00 придёт сводка по просроченным заказам.');
  Logger.log('Готово. Старых писем помечено: ' + old.length +
    '. Проверка каждые 5 минут, сводка каждый день в ' + SUMMARY_HOUR + ':00 (' +
    Session.getScriptTimeZone() + ').');
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
        sendOrder_(parseOrder_(msg.getSubject(), msg.getBody(), msg.getDate()));
        Utilities.sleep(500);
      });
      thread.addLabel(label);
    });

    pollReactions_();
  } finally {
    lock.releaseLock();
  }
}

/** Сводка по срокам отправки — её запускает расписание раз в день. */
function dailySummary() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    pollReactions_();
    const tz = Session.getScriptTimeZone();
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const overdue = [], dueToday = [];

    loadTracked_().forEach(t => {
      if (t.ok.length || !t.ship) return;
      if (t.ship < today) overdue.push(t);
      else if (t.ship === today) dueToday.push(t);
    });
    overdue.sort((a, b) => a.ship < b.ship ? -1 : 1);

    const L = ['⏰ <b>Сводка по отправке — ' + ruDay_(today) + '</b>', ''];
    if (overdue.length) {
      L.push('🔴 <b>Просрочены (' + overdue.length + '):</b>');
      overdue.forEach(t => L.push('• ' + orderRef_(t) + ' — до ' + ruDay_(t.ship) +
        ', просрочен на ' + daysBetween_(t.ship, today) + ' дн.'));
      L.push('');
    }
    if (dueToday.length) {
      L.push('🟡 <b>Отправить сегодня (' + dueToday.length + '):</b>');
      dueToday.forEach(t => L.push('• ' + orderRef_(t)));
      L.push('');
    }
    if (!overdue.length && !dueToday.length) L.push('✅ Просроченных заказов нет.');
    else L.push('Отправленный заказ отметьте реакцией ' + DONE_EMOJI + '.');

    sendTelegram_(L.join('\n').trim());
    cleanupTracked_(today);
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
  sendOrder_(parseOrder_(msg.getSubject(), msg.getBody(), msg.getDate()));
  Logger.log('Отправлен заказ: ' + msg.getSubject());
}

/** Тест: прислать сводку прямо сейчас. */
function testSummary() {
  dailySummary();
}

/** Показывает id чатов, где писали боту. Сначала напишите что-нибудь в группе. */
function getChatId() {
  const data = telegram_('getUpdates', {});
  const chats = JSON.parse(PropertiesService.getScriptProperties().getProperty('SEEN_CHATS') || '{}');
  (data.result || []).forEach(u => {
    const m = u.message || u.channel_post || u.my_chat_member || u.message_reaction || {};
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

function parseOrder_(subject, html, date) {
  const o = { items: [] };

  // Тема: You made a sale on Etsy - Ship by Nov 25 - [€21,90, Order #4236106400]
  let m = subject.match(/Ship by ([^-\[]+)/i);
  if (m) {
    o.shipBy = m[1].trim();
    o.shipDate = shipDate_(o.shipBy, date || new Date());
  }
  m = subject.match(/\[(.+?),\s*Order #(\d+)\]/i);
  if (m) { o.total = m[1].trim(); o.orderId = m[2]; }

  // Адрес
  m = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (m) {
    const lines = toText_(m[1]).split('\n').map(s => s.trim()).filter(Boolean);
    o.name = lines.shift();
    o.address = lines.join('\n');
  }

  // Фото товаров: <a href=".../transaction/ID"><img src="..."></a>
  const images = {};
  const ir = /href="https?:\/\/www\.etsy\.com\/transaction\/(\d+)[^"]*"[^>]*>\s*<img[^>]+src="([^"]+)"/gi;
  while ((m = ir.exec(html)) !== null) images[m[1]] = decode_(m[2]);

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
      image: images[it.id] || '',
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
  L.push((o.num ? '<b>' + o.num + ')</b> ' : '') + '🛍 <b>Новый заказ #' + esc_(o.orderId || '?') + '</b>');
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

  let msg = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n…';
  return msg;
}

// ───────────────────────────── отправка ─────────────────────────────

/** Фото товаров + текст. Если фото не получилось — заказ всё равно уходит текстом. */
function sendOrder_(o) {
  o.num = orderNumber_(o.orderId);
  const text = formatOrder_(o);
  const urls = Array.from(new Set(o.items.map(it => it.image).filter(Boolean))).slice(0, 10);
  const photos = urls.map(fetchPhoto_).filter(Boolean);
  const ids = [];
  const collect = res => [].concat(res && res.result || []).forEach(r => r.message_id && ids.push(r.message_id));

  if (!photos.length) {
    collect(sendTelegram_(text));
  } else {
    const caption = text.length <= 1024 ? text : null; // лимит подписи к фото в Telegram
    try {
      if (photos.length === 1) {
        const payload = { chat_id: getProp_('TELEGRAM_CHAT_ID'), photo: photos[0] };
        if (caption) { payload.caption = caption; payload.parse_mode = 'HTML'; }
        collect(telegram_('sendPhoto', payload));
      } else {
        const payload = { chat_id: getProp_('TELEGRAM_CHAT_ID') };
        const media = photos.map((blob, i) => {
          payload['p' + i] = blob;
          const item = { type: 'photo', media: 'attach://p' + i };
          if (i === 0 && caption) { item.caption = caption; item.parse_mode = 'HTML'; }
          return item;
        });
        payload.media = JSON.stringify(media);
        collect(telegram_('sendMediaGroup', payload));
      }
      if (!caption) collect(sendTelegram_(text));
    } catch (e) {
      Logger.log('Фото не отправилось: ' + e.message);
      collect(sendTelegram_(text));
    }
  }
  trackOrder_(o, ids);
}

/**
 * Сквозной номер заказа: 1086), 1087), ...
 * Один и тот же заказ всегда получает один и тот же номер.
 */
function orderNumber_(orderId) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  const own = !lock.hasLock(); // checkNewOrders уже держит блокировку
  if (own) lock.waitLock(20000);
  try {
    let map = {};
    try { map = JSON.parse(props.getProperty('ORDER_NUMBERS') || '{}'); } catch (e) {}
    if (orderId && map[orderId]) return map[orderId];
    const num = parseInt(props.getProperty('NEXT_ORDER_NUMBER') || START_NUMBER, 10);
    if (orderId) {
      map[orderId] = num;
      const keys = Object.keys(map);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete map[k]);
    }
    props.setProperties({ ORDER_NUMBERS: JSON.stringify(map), NEXT_ORDER_NUMBER: String(num + 1) });
    return num;
  } finally {
    if (own) lock.releaseLock();
  }
}

/** Скачивает фото: сначала большое (570px), если не вышло — миниатюру из письма. */
function fetchPhoto_(url) {
  const big = url.replace(/\/il_\d+x\d+\./, '/il_570xN.');
  for (const u of big !== url ? [big, url] : [url]) {
    try {
      const res = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200 && /^image\//.test(res.getHeaders()['Content-Type'] || '')) {
        return res.getBlob().setName('item.jpg');
      }
    } catch (e) {
      Logger.log('Не удалось скачать ' + u + ': ' + e.message);
    }
  }
  return null;
}

// ───────────────────────────── сроки и реакции 👍 ─────────────────────────────
// Для каждого заказа хранится свойство T_<номер заказа Etsy>:
//   { n: 1086, id: '4236106400', ship: '2026-11-25', msgs: [id сообщений], ok: [кто поставил 👍] }

function trackOrder_(o, msgIds) {
  if (!o.orderId) return;
  const props = PropertiesService.getScriptProperties();
  const key = 'T_' + o.orderId;
  let t = {};
  try { t = JSON.parse(props.getProperty(key) || '{}'); } catch (e) {}
  t.n = o.num;
  t.id = o.orderId;
  t.ship = o.shipDate || t.ship || '';
  t.chat = String(getProp_('TELEGRAM_CHAT_ID'));
  t.msgs = Array.from(new Set((t.msgs || []).concat(msgIds))).slice(-20);
  t.ok = t.ok || [];
  props.setProperty(key, JSON.stringify(t));
}

function loadTracked_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).filter(k => k.indexOf('T_') === 0).map(k => {
    try { return JSON.parse(all[k]); } catch (e) { return null; }
  }).filter(Boolean);
}

/** Забирает из Telegram новые реакции и отмечает заказы с 👍 как отправленные. */
function pollReactions_() {
  const props = PropertiesService.getScriptProperties();
  const offset = parseInt(props.getProperty('TG_OFFSET') || '0', 10);
  let data;
  try {
    const payload = {
      timeout: 0,
      allowed_updates: JSON.stringify(['message', 'my_chat_member', 'message_reaction']),
    };
    if (offset) payload.offset = offset;
    data = telegram_('getUpdates', payload);
  } catch (e) {
    Logger.log('Не удалось получить реакции: ' + e.message);
    return;
  }
  const updates = data.result || [];
  if (!updates.length) return;

  const tracked = loadTracked_();
  const byMsg = {};
  tracked.forEach(t => (t.msgs || []).forEach(id => { byMsg[id] = t; })); // бот пишет в одну группу
  const changed = {};
  const seen = JSON.parse(props.getProperty('SEEN_CHATS') || '{}');

  updates.forEach(u => {
    const any = u.message || u.my_chat_member || u.message_reaction;
    if (any && any.chat) seen[any.chat.id] = any.chat.title || any.chat.username || any.chat.first_name;

    const r = u.message_reaction;
    if (!r) return;
    const t = byMsg[r.message_id];
    if (!t) return;
    const who = String((r.user && r.user.id) || (r.actor_chat && r.actor_chat.id) || 'anon');
    const has = list => (list || []).some(x => x.type === 'emoji' && x.emoji === DONE_EMOJI);
    const before = t.ok.length;
    if (has(r.new_reaction) && t.ok.indexOf(who) < 0) t.ok.push(who);
    if (!has(r.new_reaction) && has(r.old_reaction)) t.ok = t.ok.filter(x => x !== who);
    if (t.ok.length !== before) {
      if (!t.ok.length) delete t.done;
      else if (!t.done) t.done = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      changed[t.id] = t;
    }
  });

  const save = { TG_OFFSET: String(updates[updates.length - 1].update_id + 1), SEEN_CHATS: JSON.stringify(seen) };
  Object.keys(changed).forEach(id => { save['T_' + id] = JSON.stringify(changed[id]); });
  props.setProperties(save);
}

/** Удаляет записи об отправленных заказах старше 14 дней и любых заказах старше 60 дней. */
function cleanupTracked_(today) {
  const props = PropertiesService.getScriptProperties();
  loadTracked_().forEach(t => {
    const doneOld = t.done && daysBetween_(t.done, today) > 14;
    const veryOld = t.ship && daysBetween_(t.ship, today) > 60;
    if (doneOld || veryOld) props.deleteProperty('T_' + t.id);
  });
}

/** «Nov 25» + дата письма → '2026-11-25' (год берётся из даты письма). */
function shipDate_(shipBy, date) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = shipBy.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/);
  if (!m || months.indexOf(m[1].toLowerCase()) < 0) return '';
  const mon = months.indexOf(m[1].toLowerCase());
  let year = date.getFullYear();
  if (mon < date.getMonth() - 6) year++; // заказ в декабре, отправка в январе
  const pad = n => (n < 10 ? '0' : '') + n;
  return year + '-' + pad(mon + 1) + '-' + pad(+m[2]);
}

function daysBetween_(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function ruDay_(iso) {
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const p = iso.split('-');
  return +p[2] + ' ' + months[+p[1] - 1];
}

/** «1086) #4236106400» — со ссылкой на сообщение в группе, если это супергруппа. */
function orderRef_(t) {
  const label = '<b>' + t.n + ')</b> #' + t.id;
  const chat = String(t.chat || '');
  if (chat.indexOf('-100') === 0 && t.msgs && t.msgs.length) {
    return '<a href="https://t.me/c/' + chat.slice(4) + '/' + t.msgs[0] + '">' + label + '</a>';
  }
  return label;
}

// ───────────────────────────── утилиты ─────────────────────────────

function telegram_(method, payload) {
  const token = getProp_('TELEGRAM_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', payload: payload, muteHttpExceptions: true,
  });
  const body = res.getContentText();
  if (res.getResponseCode() !== 200) {
    // Группа стала супергруппой → у неё новый id. Запоминаем и повторяем.
    let j = {};
    try { j = JSON.parse(body); } catch (e) {}
    const newId = j.parameters && j.parameters.migrate_to_chat_id;
    if (newId && payload.chat_id) {
      PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(newId));
      payload.chat_id = String(newId);
      return telegram_(method, payload);
    }
    throw new Error('Telegram ответил ' + res.getResponseCode() + ': ' + body);
  }
  return JSON.parse(body);
}

function sendTelegram_(text) {
  return telegram_('sendMessage', {
    chat_id: getProp_('TELEGRAM_CHAT_ID'),
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });
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
