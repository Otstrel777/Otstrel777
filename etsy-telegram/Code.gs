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
 *   4. (по желанию) Запустить createPhotoSheet — создаст таблицу «заголовок листинга → фото».
 */

const QUERY = 'subject:"You made a sale on Etsy" newer_than:3d';
const LABEL_NAME = 'Etsy/Отправлено в TG';
const START_NUMBER = 1086;  // с какого номера начинать нумерацию заказов
const DONE_EMOJI = '👍';    // реакция «заказ отправлен»
const SUMMARY_HOUR = 9;     // во сколько присылать сводку (час, по часовому поясу проекта)
// Слова, по которым товар считается комплектом (ищутся только в варианте Size). Обычное «set» не считается.
const BUNDLE_WORDS = ['bundle', 'combo', 'бандл', 'комбо', 'комплект'];
// Упаковка по категориям (ищется в названии листинга) — строка в конце заказа.
// Если в заказе несколько категорий, берётся первая подходящая сверху.
const PACKAGING = [
  { name: 'KURA',      match: /kura/i,
    de: 'DHL Kleinpaket 35×25×5 см', us: 'DHL 60 см',    other: 'Warenpost 35×25×5 см' },
  { name: 'DUKTIG',    match: /duktig/i,
    de: 'DHL Kleinpaket 35×25×5 см', us: 'DHL 60 см',    other: 'Warenpost 35×25×5 см' },
  { name: 'Dollhouse', match: /doll\s*-?house|puppenhaus/i,
    de: 'DHL Kleinpaket 35×25×5 см', us: 'DHL 60 см',    other: 'Warenpost 35×25×5 см' },
  { name: 'TROFAST',   match: /trofast/i,
    de: 'DHL Kleinpaket 35×25×5 см', us: 'DHL 60 см',    other: 'Warenpost 35×25×5 см' },
];
const TEST_ORDER = 1099;    // какой заказ прислать функцией testOrder: наш номер (1099) или номер Etsy (4236960738)
const SHEET_PHOTOS = 'add'; // фото из таблицы: 'add' — добавить к фото из письма, 'replace' — вместо них

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
    const started = Date.now();
    const threads = GmailApp.search(QUERY, 0, 50).filter(
      t => !t.getLabels().some(l => l.getName() === LABEL_NAME));

    // от старых к новым
    for (const thread of threads.reverse()) {
      if (Date.now() - started > 4 * 60 * 1000) break; // остальное — в следующий запуск
      thread.getMessages().forEach(msg => {
        if (!/You made a sale on Etsy/i.test(msg.getSubject())) return;
        const o = parseOrder_(msg.getSubject(), msg.getBody(), msg.getDate());
        if (alreadySent_(o.orderId)) {
          Logger.log('Заказ #' + o.orderId + ' уже был отправлен — повторно не шлю');
          return;
        }
        sendOrder_(o);
        Utilities.sleep(500);
      });
      thread.addLabel(label);
    }

    retryPendingPhotos_();
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
      if (t.ok.length || !t.ship || t.ship > today) return;
      if (deletedFromChat_(t)) return; // сообщение заказа удалили из чата — не напоминаем
      if (t.ship < today) overdue.push(t);
      else dueToday.push(t);
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

/** Тест: отправить в группу последний заказ ещё раз (с пометкой «повтор»). */
function testLastOrder() {
  const threads = GmailApp.search('subject:"You made a sale on Etsy"', 0, 1);
  if (!threads.length) throw new Error('Писем «You made a sale on Etsy» не найдено');
  const msgs = threads[0].getMessages();
  const msg = msgs[msgs.length - 1];
  const o = parseOrder_(msg.getSubject(), msg.getBody(), msg.getDate());
  o.repeat = true;
  sendOrder_(o);
  Logger.log('Отправлен заказ: ' + msg.getSubject());
}

/**
 * Тест: прислать заказ из TEST_ORDER ещё раз (с пометкой «повтор»).
 * Впишите номер в начале скрипта, сохраните (Cmd+S) и запустите testOrder.
 */
function testOrder() {
  const want = String(TEST_ORDER).trim().replace(/^#/, '');
  let orderId = want;
  if (want.length < 7) { // короткий — это наш номер 1099, ищем номер заказа Etsy
    let map = {};
    try { map = JSON.parse(PropertiesService.getScriptProperties().getProperty('ORDER_NUMBERS') || '{}'); } catch (e) {}
    orderId = Object.keys(map).filter(id => String(map[id]) === want)[0];
    if (!orderId) throw new Error('Заказ с номером ' + want + ') не найден. Укажите номер заказа Etsy (например 4236960738).');
  }
  const threads = GmailApp.search('subject:"You made a sale on Etsy" subject:' + orderId, 0, 5);
  for (const th of threads) {
    for (const msg of th.getMessages()) {
      if (msg.getSubject().indexOf(orderId) < 0) continue;
      const o = parseOrder_(msg.getSubject(), msg.getBody(), msg.getDate());
      o.repeat = true;
      sendOrder_(o);
      Logger.log('Отправлен заказ #' + orderId + ': ' + msg.getSubject());
      return;
    }
  }
  throw new Error('Письмо заказа #' + orderId + ' не найдено во второй почте.');
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
  o.totals = parseTotals_(text);
  const grand = o.totals.filter(t => /^order total$/i.test(t.label))[0];
  if (grand) o.total = grand.value;
  o.tax = parseTaxNotice_(text);
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

/**
 * Блок «Order total» из письма: [{ label: 'Item total', value: '€29,00' }, ...].
 * Берём только строки после заголовка «Order total», чтобы не путать с текстом про доставку выше.
 */
function parseTotals_(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  let i = lines.lastIndexOf('Order total');
  if (i < 0) i = lines.findIndex(l => /^Item total:?$/i.test(l)) - 1;
  if (i < -1) return [];
  const out = [];
  for (let k = i + 1; k < lines.length - 1 && out.length < 12; k++) {
    const lm = lines[k].match(/^([A-Za-z][A-Za-z ()]+):\s*(.*)$/);
    if (!lm) break;
    const value = lm[2] || lines[++k];
    out.push({ label: lm[1].trim(), value: value.trim() });
    if (/^order total$/i.test(lm[1].trim())) break;
  }
  return out;
}

/**
 * Налоговая пометка Etsy (UK VAT, Норвегия VOEC, IOSS и т. п.):
 * { title, ids: [{ kind, id }], value } или null.
 */
function parseTaxNotice_(text) {
  const start = text.search(/Double check any customs requirements[^\n]*\n/i);
  const end = text.search(/\nSell with confidence/i);
  if (start < 0 || end < 0 || end <= start) return null;
  const block = text.slice(start, end).split('\n').slice(1).map(s => s.trim())
    .filter(l => l && !/^learn more\.?$/i.test(l) && !/^using shipping labels/i.test(l));
  if (!block.length) return null;
  const all = block.join(' ');
  const ids = [];
  const re = /\b(VAT|VOEC|IOSS|OSS|ARN|ABN|GST|IRD|UID|tax)\b[^.()]{0,40}?\bnumber\b[^A-Za-z0-9]{0,5}(?:is\s+)?([A-Z]{0,4}\s?\d[\d ]{3,}\d)/gi;
  let m;
  while ((m = re.exec(all)) !== null) {
    const id = m[2].trim();
    if (!ids.some(x => x.id === id)) ids.push({ kind: m[1].toUpperCase(), id: id });
  }
  const v = all.match(/value of this order in [a-z]+,\s*(.+?),\s*on your package/i);
  return { title: block[0], ids: ids, value: v ? v[1].trim() : '' };
}

const TOTAL_LABELS_ = {
  'item total': ['💰', 'Товары'], 'discount': ['🏷', 'Скидка'], 'subtotal': ['➖', 'Подытог'],
  'shipping': ['🚚', 'Доставка'], 'tax': ['🧾', 'Налог'], 'sales tax': ['🧾', 'Налог (sales tax)'],
  'vat': ['🧾', 'НДС (VAT)'], 'gift wrap': ['🎁', 'Упаковка'],
};

/**
 * Комплект: в варианте Size есть слово из BUNDLE_WORDS
 * или размеры через плюс — «3 Small + 3 Medium», «3 SM + 3 MD», «BUNDLE ( 3 sm + 3md)».
 * Название листинга и другие варианты (цвет, персонализация) не учитываются.
 */
function isBundle_(it) {
  const text = (it.variations || []).filter(v => /^\s*(size|размер)\b/i.test(v)).join(' \n ');
  if (!text) return false;
  const low = text.toLowerCase();
  if (BUNDLE_WORDS.some(w => low.indexOf(w.toLowerCase()) >= 0)) return true;
  const size = '(?:x[\\s-]?)?(?:small|medium|large|sm|md|lg|s|m|l|xl)\\b';
  return new RegExp('\\d+\\s*' + size + '[^\\n+&]{0,25}[+&]\\s*\\d+\\s*' + size, 'i').test(text);
}

/**
 * Ящики IKEA TROFAST: «Wider Side» в варианте Size — наклейка на длинную сторону.
 * Для остальных товаров — null (строка не показывается).
 */
function trofastSide_(it) {
  if (!/trofast/i.test(it.title || '')) return null;
  const size = (it.variations || []).filter(v => /^\s*(size|размер)\b/i.test(v)).join(' ');
  return /\bwide(r)?[\s-]*side|\bwhite[\s-]*side|\blong[\s-]*side/i.test(size)
    ? '<b>Длинный ‼️</b>' : 'Обычный';
}

/**
 * Упаковка по категории товара (PACKAGING) и стране доставки (последняя строка адреса).
 * Германия → de, США → us, остальные страны → other. Товары без категории → null.
 */
function packagingHint_(o) {
  const titles = (o.items || []).map(it => it.title || '').join(' \n ');
  const rule = PACKAGING.filter(r => r.match.test(titles))[0];
  if (!rule) return null;
  const lines = String(o.address || '').split('\n').map(s => s.trim()).filter(Boolean);
  const country = (lines[lines.length - 1] || '').toLowerCase();
  if (!country) return null;
  const zone = /^(germany|deutschland)$/.test(country) ? 'de'
    : /^(united states|united states of america|usa|us)$/.test(country) ? 'us' : 'other';
  return rule[zone];
}

function plural_(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
  return many;
}

function formatOrder_(o) {
  const L = [];
  if (o.repeat) L.push('🔁 <i>Повторная отправка (тест) — это не новый заказ</i>');
  L.push((o.num ? '<b>' + o.num + ')</b> ' : '') + '🛍 <b>Новый заказ #' + esc_(o.orderId || '?') + '</b>');
  if (o.shipBy) L.push('📦 Отправить до: <b>' + esc_(ruDate_(o.shipBy)) + '</b>');
  L.push('');

  o.items.forEach((it, i) => {
    const qty = isBundle_(it) ? ' × <b>' + it.quantity + ' ' + plural_(it.quantity, 'комплект', 'комплекта', 'комплектов') + ' ‼️</b>'
      : it.quantity > 1 ? ' × <b>' + it.quantity + ' шт. ‼️</b>' : ' × 1';
    L.push('<b>' + (i + 1) + '. ' + esc_(it.title) + '</b>' + qty);
    it.variations.forEach(v => {
      const pm = v.match(/^Personali[sz]ation:\s*([\s\S]*)/i);
      L.push(pm ? '   ✏️ <b>Персонализация:</b> ' + esc_(pm[1]) : '   • ' + esc_(v));
    });
    const side = trofastSide_(it);
    if (side) L.push('   📏 ' + side);
    if (it.price) L.push('   ' + esc_(it.price));
    L.push('');
  });

  if (o.note) L.push('💬 <b>Сообщение покупателя:</b> <i>' + esc_(o.note) + '</i>', '');
  if (o.gift) L.push('🎁 <b>Подарок:</b> <i>' + esc_(o.gift) + '</i>', '');

  if (o.name) L.push('👤 ' + esc_(o.name));
  if (o.address) L.push('📍 <code>' + esc_(o.address) + '</code>');
  L.push('');

  // Разбивка суммы — как в письме
  const isZero = v => /^-?\s*\D*0([.,]0+)?\s*\D*$/.test(v);
  (o.totals || []).forEach(t => {
    const key = t.label.toLowerCase();
    if (key === 'order total') return;
    if ((key === 'discount' || key.indexOf('tax') >= 0 || key === 'vat') && isZero(t.value)) return;
    const lbl = TOTAL_LABELS_[key] || ['•', t.label];
    let val = t.value.replace(/^-\s*/, '−');
    if (key === 'discount' && o.coupons) val += ' (' + o.coupons + ')';
    L.push(lbl[0] + ' ' + lbl[1] + ': ' + esc_(val));
  });
  L.push('💶 <b>Итого: ' + esc_(o.total || '—') + '</b>');

  // Налоговый номер для посылки
  if (o.tax) {
    L.push('');
    L.push('📮 <b>Налог для посылки</b> <i>(' + esc_(o.tax.title) + ')</i>');
    o.tax.ids.forEach(x => {
      const what = x.kind === 'VOEC' ? 'VOEC-номер Etsy (указать при оформлении отправки)'
        : x.kind === 'VAT' ? 'VAT-номер Etsy (написать на посылке)'
        : x.kind + '-номер Etsy';
      L.push('   ' + what + ': <code>' + esc_(x.id) + '</code>');
    });
    if (o.tax.value) L.push('   Стоимость заказа для посылки: <b>' + esc_(o.tax.value) + '</b>');
    if (!o.tax.ids.length) L.push('   (номер не распознан — см. письмо)');
  }

  const pack = packagingHint_(o);
  if (pack) L.push('', '📫 <b>' + esc_(pack) + '</b>');

  let msg = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n…';
  return msg;
}

// ───────────────────────────── отправка ─────────────────────────────

/** Фото товаров + текст. Если фото не получилось — заказ всё равно уходит текстом. */
function sendOrder_(o) {
  o.num = orderNumber_(o.orderId);
  const text = formatOrder_(o);
  const photos = collectPhotos_(o);
  // id отправленных сообщений сохраняем сразу — если запуск оборвётся, заказ не уйдёт второй раз
  const collect = res => {
    const ids = [];
    [].concat(res && res.result || []).forEach(r => r.message_id && ids.push(r.message_id));
    trackOrder_(o, ids);
  };
  const caption = text.length <= 1024 ? text : null; // лимит подписи к фото в Telegram

  const sendPhotos = list => {
    if (list.length === 1) {
      const payload = { chat_id: getProp_('TELEGRAM_CHAT_ID'), photo: list[0] };
      if (caption) { payload.caption = caption; payload.parse_mode = 'HTML'; }
      return telegram_('sendPhoto', payload);
    }
    const payload = { chat_id: getProp_('TELEGRAM_CHAT_ID') };
    const media = list.map((blob, i) => {
      payload['p' + i] = blob;
      const item = { type: 'photo', media: 'attach://p' + i };
      if (i === 0 && caption) { item.caption = caption; item.parse_mode = 'HTML'; }
      return item;
    });
    payload.media = JSON.stringify(media);
    return telegram_('sendMediaGroup', payload);
  };

  // Заказ ушёл текстом, хотя фото должно быть → запомнить, чтобы позже добавить фото в это же сообщение
  const sendTextAwaitingPhoto = () => {
    const res = sendTelegram_(text);
    collect(res);
    setTextRef_(o, firstId_(res), false, text);
    const hasPhotoSource = o.items.some(it => it.image) || sheetHasPhotos_(o);
    if (caption && hasPhotoSource && res && res.result && res.result.message_id) {
      markPhotoPending_(o, res.result.message_id, caption);
    }
  };

  if (!photos.length) {
    Logger.log('Заказ #' + o.orderId + ': фото не скачались, отправляю текстом — фото добавлю позже');
    sendTextAwaitingPhoto();
    return;
  }
  let sent = false;
  for (const attempt of [photos, photos.slice(0, 1)]) { // 2-я попытка — только первое фото
    try {
      const res = sendPhotos(attempt);
      collect(res);
      if (caption) setTextRef_(o, firstId_(res), true, text);
      sent = true;
      break;
    } catch (e) {
      Logger.log('Заказ #' + o.orderId + ': фото не отправилось (' + attempt.length + ' шт.): ' + e.message);
      Utilities.sleep(2000);
    }
  }
  if (!sent) sendTextAwaitingPhoto();
  else if (!caption) {
    const res = sendTelegram_(text);
    collect(res);
    setTextRef_(o, firstId_(res), false, text);
  }
}

function firstId_(res) {
  const r = [].concat(res && res.result || [])[0];
  return r && r.message_id;
}

/** Запоминает, в каком сообщении текст заказа (для пометок «+»). */
function setTextRef_(o, msgId, isCaption, html) {
  if (!o.orderId || !msgId) return;
  const props = PropertiesService.getScriptProperties();
  const key = 'T_' + o.orderId;
  let t = {};
  try { t = JSON.parse(props.getProperty(key) || '{}'); } catch (e) {}
  t.tm = msgId;
  t.cap = !!isCaption;
  t.html = html;
  delete t.notes; // повторная отправка — пометки начинаются заново
  props.setProperty(key, JSON.stringify(t));
}

// ───────────────────────────── дозагрузка фото ─────────────────────────────
// Если заказ ушёл без фото, при следующих проверках скрипт добавляет фото
// в ЭТО ЖЕ сообщение (editMessageMedia): текст становится подписью, место в чате не меняется.

const PHOTO_RETRY_MAX = 12; // попыток (раз в 5 минут ≈ 1 час)

function markPhotoPending_(o, msgId, caption) {
  const props = PropertiesService.getScriptProperties();
  const key = 'T_' + o.orderId;
  let t = {};
  try { t = JSON.parse(props.getProperty(key) || '{}'); } catch (e) {}
  t.pending = {
    msg: msgId,
    cap: caption,
    items: o.items.map(it => ({ t: it.title, i: it.image })),
    tries: 0,
  };
  props.setProperty(key, JSON.stringify(t));
}

function sheetHasPhotos_(o) {
  try {
    return o.items.some(it => sheetPhotosFor_(it.title).length > 0);
  } catch (e) {
    return false;
  }
}

/** Пробует добавить фото к заказам, которые ушли текстом. Вызывается в каждой проверке. */
function retryPendingPhotos_() {
  const props = PropertiesService.getScriptProperties();
  loadTracked_().filter(t => t.pending).forEach(t => {
    const p = t.pending;
    const photos = collectPhotos_({ items: p.items.map(x => ({ title: x.t, image: x.i })) });
    let done = false;
    for (const blob of photos) {
      try {
        telegram_('editMessageMedia', {
          chat_id: getProp_('TELEGRAM_CHAT_ID'),
          message_id: String(p.msg),
          media: JSON.stringify({ type: 'photo', media: 'attach://p0', caption: p.cap, parse_mode: 'HTML' }),
          p0: blob,
        });
        done = true;
        break;
      } catch (e) {
        Logger.log('Заказ #' + t.id + ': не удалось добавить фото к сообщению: ' + e.message);
      }
    }
    p.tries++;
    if (done) {
      Logger.log('Заказ #' + t.id + ': фото добавлено к сообщению');
      if (t.tm === p.msg) t.cap = true;
      delete t.pending;
    } else if (p.tries >= PHOTO_RETRY_MAX) {
      Logger.log('Заказ #' + t.id + ': фото так и не удалось добавить, оставляю текстом');
      delete t.pending;
    }
    props.setProperty('T_' + t.id, JSON.stringify(t));
  });
}

/** Был ли заказ уже отправлен в группу. */
function alreadySent_(orderId) {
  if (!orderId) return false;
  try {
    const t = JSON.parse(PropertiesService.getScriptProperties().getProperty('T_' + orderId) || '{}');
    return !!(t.msgs && t.msgs.length);
  } catch (e) {
    return false;
  }
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
      const res = UrlFetchApp.fetch(u, {
        muteHttpExceptions: true,
        headers: { Accept: 'image/jpeg,image/png;q=0.9,image/webp;q=0.5' }, // без AVIF — Telegram его не берёт
      });
      if (okImage_(res)) return res.getBlob().setName('item.jpg');
      Logger.log('Фото не скачалось (' + res.getResponseCode() + ', ' +
        (res.getHeaders()['Content-Type'] || '?') + '): ' + u);
    } catch (e) {
      Logger.log('Не удалось скачать ' + u + ': ' + e.message);
    }
  }
  return null;
}

// ───────────────────────────── фото из таблицы ─────────────────────────────
// Таблица: A — заголовок листинга, B, C, D… — фото (ссылка с Google Диска,
// прямая ссылка на картинку, =IMAGE("…") или картинка, вставленная в ячейку).

/** Фото для заказа: из письма + из таблицы (не больше 10 — лимит альбома Telegram). */
function collectPhotos_(o) {
  const emailUrls = Array.from(new Set(o.items.map(it => it.image).filter(Boolean)));
  const sheetCells = [];
  const seen = {};
  Array.from(new Set(o.items.map(it => it.title))).forEach(title => {
    sheetPhotosFor_(title).forEach(c => {
      if (!seen[c.key]) { seen[c.key] = true; sheetCells.push(c); }
    });
  });

  const fromSheet = () => sheetCells.map(cellToBlob_).filter(Boolean);
  const fromEmail = () => emailUrls.map(fetchPhoto_).filter(Boolean);
  let photos;
  if (SHEET_PHOTOS === 'replace') {
    photos = fromSheet();
    if (!photos.length) photos = fromEmail();
  } else {
    photos = fromEmail().concat(fromSheet());
  }
  return photos.slice(0, 10);
}

let SHEET_CACHE_ = null;

function photoSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) return null;
  try {
    const ss = SpreadsheetApp.openById(id.replace(/^.*\/d\/([\w-]+).*$/, '$1'));
    return ss.getSheetByName('Фото') || ss.getSheets()[0];
  } catch (e) {
    Logger.log('Таблица с фото недоступна: ' + e.message);
    return null;
  }
}

/** Строки таблицы: [{ title, norm, cells: [{ key, value, formula }] }] — читается один раз за запуск. */
function sheetRows_() {
  if (SHEET_CACHE_) return SHEET_CACHE_;
  SHEET_CACHE_ = [];
  const sh = photoSheet_();
  if (!sh || sh.getLastRow() < 2) return SHEET_CACHE_;
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 2));
  const values = range.getValues();
  const formulas = range.getFormulas();
  values.forEach((row, r) => {
    const title = String(row[0] || '').trim();
    if (!title) return;
    const cells = [];
    for (let c = 1; c < row.length; c++) {
      const v = row[c], f = formulas[r][c];
      if (!v && !f) continue;
      const key = f || (typeof v === 'string' ? v.trim() : 'img:' + (r + 2) + ':' + (c + 1));
      cells.push({ key: key, value: v, formula: f });
    }
    SHEET_CACHE_.push({ title: title, norm: normTitle_(title), cells: cells });
  });
  return SHEET_CACHE_;
}

function normTitle_(s) {
  return String(s).toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\s.,;:!-]+$/, '')
    .trim();
}

/** Фото для заголовка. Незнакомый заголовок дописывается в таблицу, чтобы вы добавили к нему фото. */
function sheetPhotosFor_(title) {
  const sh = photoSheet_();
  if (!sh) return [];
  const rows = sheetRows_();
  const n = normTitle_(title);
  let best = rows.find(r => r.norm === n);
  if (!best) {
    // заголовок в таблице мог быть сокращён — ищем самое длинное совпадение начала
    rows.filter(r => r.norm.length >= 15 && (n.indexOf(r.norm) === 0 || r.norm.indexOf(n) === 0))
      .forEach(r => { if (!best || r.norm.length > best.norm.length) best = r; });
  }
  if (!best) {
    sh.appendRow([title]);
    rows.push({ title: title, norm: n, cells: [] });
    return [];
  }
  return best.cells;
}

/** Ячейка таблицы → картинка. */
function cellToBlob_(cell) {
  try {
    const f = String(cell.formula || '').match(/IMAGE\(\s*"([^"]+)"/i);
    if (f) return fetchPhoto_(f[1]);

    const v = cell.value;
    if (v && typeof v === 'object' && typeof v.getContentUrl === 'function') { // картинка в ячейке
      const res = UrlFetchApp.fetch(v.getContentUrl(), {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      return okImage_(res) ? res.getBlob().setName('item.jpg') : null;
    }

    const s = String(v || '').trim();
    const drive = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/);
    if (drive) {
      const blob = DriveApp.getFileById(drive[1]).getBlob();
      if (!/^image\/(jpeg|png|webp)/.test(blob.getContentType()) || blob.getBytes().length > 10e6) {
        Logger.log('Нужен JPG/PNG до 10 МБ (HEIC с iPhone Telegram не принимает): ' + s);
        return null;
      }
      return blob;
    }
    if (/^https?:\/\//i.test(s)) return fetchPhoto_(s);
  } catch (e) {
    Logger.log('Не удалось взять фото из таблицы (' + cell.key + '): ' + e.message);
  }
  return null;
}

function okImage_(res) {
  return res.getResponseCode() === 200 &&
    /^image\/(jpeg|jpg|png|webp)/i.test(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
}

/** Создаёт таблицу «Заголовок листинга → фото» и вписывает заголовки из уже пришедших заказов. */
function createPhotoSheet() {
  const props = PropertiesService.getScriptProperties();
  const existing = photoSheet_();
  if (existing) {
    Logger.log('Таблица уже есть: ' + existing.getParent().getUrl());
    return;
  }
  const ss = SpreadsheetApp.create('Etsy — фото листингов');
  const sh = ss.getSheets()[0].setName('Фото');
  sh.getRange(1, 1, 1, 6).setValues([['Заголовок листинга (как в Etsy)', 'Фото 1', 'Фото 2', 'Фото 3', 'Фото 4', 'Фото 5']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 420);

  const titles = {};
  GmailApp.search('subject:"You made a sale on Etsy"', 0, 200).forEach(t => t.getMessages().forEach(m => {
    if (/You made a sale on Etsy/i.test(m.getSubject())) {
      parseOrder_(m.getSubject(), m.getBody(), m.getDate()).items.forEach(it => { titles[it.title] = true; });
    }
  }));
  const list = Object.keys(titles).sort();
  if (list.length) sh.getRange(2, 1, list.length, 1).setValues(list.map(t => [t]));

  props.setProperty('SHEET_ID', ss.getId());
  Logger.log('Таблица создана: ' + ss.getUrl() + '  (заголовков из заказов: ' + list.length + ')');
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

    // Ответ на заказ: «+ текст» — добавить пометку, «-» — убрать последнюю
    const m = u.message;
    if (m && m.reply_to_message && typeof m.text === 'string') {
      const tn = byMsg[m.reply_to_message.message_id];
      if (tn && handleNote_(tn, m)) changed[tn.id] = tn;
      return;
    }

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

/**
 * Удалены ли из чата ВСЕ сообщения заказа. Telegram не сообщает боту об удалениях,
 * поэтому проверяем «пустой правкой» (без видимых изменений):
 * есть сообщение → «message is not modified», удалено → «message to edit not found».
 * Если все сообщения удалены — заказ убирается из отслеживания.
 */
function deletedFromChat_(t) {
  const msgs = t.msgs || [];
  if (!msgs.length) return false;
  const chat = getProp_('TELEGRAM_CHAT_ID');
  for (const id of msgs) {
    try {
      telegram_('editMessageReplyMarkup', {
        chat_id: chat,
        message_id: String(id),
        reply_markup: JSON.stringify({ inline_keyboard: [] }),
      });
      return false; // правка прошла — сообщение есть
    } catch (e) {
      if (!/message to edit not found|message_id_invalid|message not found/i.test(e.message)) return false;
    }
  }
  PropertiesService.getScriptProperties().deleteProperty('T_' + t.id);
  Logger.log('Заказ ' + t.n + ') #' + t.id + ' удалён из чата — больше не отслеживаю');
  return true;
}

// ───────────────────────────── пометки к заказу ─────────────────────────────
// Сообщения бота может редактировать только бот. Поэтому пометку добавляют ответом на заказ:
//   «+ текст» — дописать «📝 текст (Имя, дата)» в сообщение заказа;  «-» — убрать последнюю пометку.

function handleNote_(t, m) {
  const txt = m.text.trim();
  const notes = (t.notes || []).slice();
  if (/^\+/.test(txt)) {
    const note = txt.replace(/^\+\s*/, '').trim();
    if (!note) return false;
    const who = (m.from && (m.from.first_name || m.from.username)) || '';
    notes.push({ x: note.slice(0, 300), w: who, d: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM') });
  } else if (txt === '-' || txt === '−') {
    if (!notes.length) return false;
    notes.pop();
  } else {
    return false; // обычный ответ — не трогаем
  }

  const reply = m.reply_to_message;
  const chat = getProp_('TELEGRAM_CHAT_ID');
  // Заказы, отправленные старой версией скрипта: берём текст из самого сообщения (без жирного шрифта)
  if (!t.tm) {
    const plain = reply.text || reply.caption;
    if (!plain) {
      noteError_(m, 'Ответьте на сообщение, где есть текст заказа (на первое фото альбома или на текст).');
      return false;
    }
    t.tm = reply.message_id;
    t.cap = !reply.text;
    t.html = esc_(plain);
  }

  const full = (t.html || '') + (notes.length ? '\n\n' + notes.map(n =>
    '📝 <b>' + esc_(n.x) + '</b>' + (n.w ? ' <i>(' + esc_(n.w) + ', ' + n.d + ')</i>' : '')).join('\n') : '');
  if (t.cap && full.length > 1024) {
    noteError_(m, 'Пометка не поместилась: у сообщения с фото текст не может быть длиннее 1024 символов. Сократите пометку.');
    return false;
  }
  try {
    if (t.cap) {
      telegram_('editMessageCaption', { chat_id: chat, message_id: String(t.tm), caption: full, parse_mode: 'HTML' });
    } else {
      telegram_('editMessageText', { chat_id: chat, message_id: String(t.tm), text: full, parse_mode: 'HTML',
        disable_web_page_preview: 'true' });
    }
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) {
      Logger.log('Заказ #' + t.id + ': не удалось добавить пометку: ' + e.message);
      noteError_(m, 'Не удалось изменить сообщение заказа: ' + e.message.slice(0, 200));
      return false;
    }
  }
  t.notes = notes;
  if (t.pending && full.length <= 1024) t.pending.cap = full;
  try { telegram_('deleteMessage', { chat_id: chat, message_id: String(m.message_id) }); } catch (e) {} // убрать команду из чата
  return true;
}

function noteError_(m, text) {
  try {
    telegram_('sendMessage', { chat_id: getProp_('TELEGRAM_CHAT_ID'), text: '⚠️ ' + text,
      reply_to_message_id: String(m.message_id) });
  } catch (e) {}
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
    .replace(/[ \t\u00a0]+/g, ' ')
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
