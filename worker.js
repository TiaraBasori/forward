const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your user id, get it from https://t.me/username_to_id_bot

const NOTIFY_INTERVAL = 3600 * 1000;
const RATE_LIMIT_COUNT = 5; // 5 messages
const RATE_LIMIT_WINDOW = 10 * 1000; // 10 seconds

// 全局缓存对象，减少对 KV 的频繁读写
const rateLimitCache = {}

const START_MSG = "Ciallo～(∠・ω< )⌒☆\n请发送消息来与我联系哦~\nJust send your message to the bot.";
const NOTIFICATION_MSG = "新用户消息通知";

const enable_notification = true

function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body)
    .then(r => r.json())
}

function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

function sendMessage(msg = {}){
  return requestTelegram('sendMessage', makeReqBody(msg))
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage(msg){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    // 用户从浏览器直接访问时返回Ciallo消息
    event.respondWith(new Response("Ciallo～(∠・ω< )⌒☆", { status: 200 }))
  }
})

async function handleWebhook (event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }
  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  }
}

async function onMessage (message) {
  if(message.text === '/start'){
    return sendMessage({
      chat_id:message.chat.id,
      text: START_MSG,
    })
  }
  if(message.chat.id.toString() === ADMIN_UID){
    if(!message?.reply_to_message?.chat){
      return sendMessage({
        chat_id:ADMIN_UID,
        text:'使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`等指令'
      })
    }
    if(/^\/block$/.exec(message.text)){
      return handleBlock(message)
    }
    if(/^\/unblock$/.exec(message.text)){
      return handleUnBlock(message)
    }
    if(/^\/checkblock$/.exec(message.text)){
      return checkBlock(message)
    }
    let guestChantId = await env.forwardConfig.get('msg-map-' + message?.reply_to_message.message_id, { type: "json" })
    return copyMessage({
      chat_id: guestChantId,
      from_chat_id:message.chat.id,
      message_id:message.message_id,
    })
  }
  return handleGuestMessage(message)
}

async function checkRateLimit(chatId) {
  const now = Date.now();
  const key = `rate-limit-${chatId}`;
  let userMessages = rateLimitCache[key];
  if (!userMessages) {
    userMessages = await env.forwardConfig.get(key, { type: "json" }) || [];
  }
  const recentMessages = userMessages.filter(timestamp => 
    now - timestamp <= RATE_LIMIT_WINDOW
  );
  if (recentMessages.length >= RATE_LIMIT_COUNT) {
    await env.forwardConfig.put(`isblocked-${chatId}`, true);
    rateLimitCache[`isblocked-${chatId}`] = true;
    return true;
  }
  recentMessages.push(now);
  rateLimitCache[key] = recentMessages;
  await env.forwardConfig.put(key, JSON.stringify(recentMessages));
  return false;
}

async function handleGuestMessage(message){
  let chatId = message.chat.id;
  let isblocked = rateLimitCache['isblocked-' + chatId];
  if (typeof isblocked === 'undefined') {
    isblocked = await env.forwardConfig.get('isblocked-' + chatId, { type: "json" });
    rateLimitCache['isblocked-' + chatId] = isblocked;
  }
  if(isblocked){
    return sendMessage({
      chat_id: chatId,
      text:'Your are blocked'
    })
  }
  const isRateLimited = await checkRateLimit(chatId);
  if (isRateLimited) {
    await sendMessage({
      chat_id: ADMIN_UID,
      text: `用户 ${chatId} 因消息频率过高已被自动屏蔽`
    });
    return sendMessage({
      chat_id: chatId,
      text: '由于消息频率过高，您已被暂时屏蔽'
    })
  }
  let forwardReq = await forwardMessage({
    chat_id:ADMIN_UID,
    from_chat_id:message.chat.id,
    message_id:message.message_id
  })
  console.log(JSON.stringify(forwardReq))
  if(forwardReq.ok){
    await env.forwardConfig.put('msg-map-' + forwardReq.result.message_id, chatId)
  }
  return handleNotify(message)
}

async function handleNotify(message){
  let chatId = message.chat.id;
  let lastMsgTime = rateLimitCache['lastmsg-' + chatId];
  if (typeof lastMsgTime === 'undefined') {
    lastMsgTime = await env.forwardConfig.get('lastmsg-' + chatId, { type: "json" });
    rateLimitCache['lastmsg-' + chatId] = lastMsgTime;
  }
  if(enable_notification){
    if(!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL){
      rateLimitCache['lastmsg-' + chatId] = Date.now();
      await env.forwardConfig.put('lastmsg-' + chatId, Date.now())
      return sendMessage({
        chat_id: ADMIN_UID,
        text: NOTIFICATION_MSG
      })
    }
  }
}

async function handleBlock(message){
  let guestChantId = await env.forwardConfig.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  if(guestChantId === ADMIN_UID){
    return sendMessage({
      chat_id: ADMIN_UID,
      text:'不能屏蔽自己'
    })
  }
  await env.forwardConfig.put('isblocked-' + guestChantId, true)
  rateLimitCache['isblocked-' + guestChantId] = true
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}屏蔽成功`,
  })
}

async function handleUnBlock(message){
  let guestChantId = await env.forwardConfig.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  await env.forwardConfig.put('isblocked-' + guestChantId, false)
  rateLimitCache['isblocked-' + guestChantId] = false
  return sendMessage({
    chat_id: ADMIN_UID,
    text:`UID:${guestChantId}解除屏蔽成功`,
  })
}

async function checkBlock(message){
  let guestChantId = await env.forwardConfig.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  let blocked = rateLimitCache['isblocked-' + guestChantId];
  if (typeof blocked === 'undefined') {
    blocked = await env.forwardConfig.get('isblocked-' + guestChantId, { type: "json" })
    rateLimitCache['isblocked-' + guestChantId] = blocked;
  }
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}` + (blocked ? '被屏蔽' : '没有被屏蔽')
  })
}

async function sendPlainText (chatId, text) {
  return sendMessage({
    chat_id: chatId,
    text
  })
}

async function registerWebhook (event, requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}
