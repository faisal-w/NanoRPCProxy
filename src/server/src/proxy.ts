import {Credentials, CredentialSettings} from "./credential-settings";
import ProxySettings from './proxy-settings';
import {CachedCommands, Command, LimitedCommands, log_levels, LogData, LogLevel} from "./common-settings";
import {UserSettings, UserSettingsConfig} from "./user-settings";
import {PowSettings} from "./pow-settings";
import SlowDown from "express-slow-down";
import FileSync from 'lowdb/adapters/FileSync.js';
import lowdb from 'lowdb'
import {OrderDB, OrderSchema, TrackedAccount, User, UserDB, UserSchema} from "./lowdb-schema";
import {ErrorRequestHandler, NextFunction, Request, Response} from "express";
import {CorsOptions} from "cors";
import {RateLimiterRes} from "rate-limiter-flexible";
import ErrnoException = NodeJS.ErrnoException;
import {IncomingMessage, ServerResponse} from "http";
import {connection, IMessage, request as WSRequest, server as WSServer} from "websocket";
import ReconnectingWebSocket, { ErrorEvent } from "reconnecting-websocket";
import NodeCache from "node-cache";

require('dotenv').config() // load variables from .env into the environment
require('console-stamp')(console)
const test_override_http = !process.env.OVERRIDE_USE_HTTP

const BasicAuth =             require('express-basic-auth')
const Http =                  require('http')
const Https =                 require('https')
const Fs =                    require('fs')
const Express =               require('express')
const Cors =                  require('cors')
const IpFilter =              require('express-ipfilter').IpFilter
const IpDeniedError =         require('express-ipfilter').IpDeniedError
const Schedule =              require('node-schedule')
const WebSocketServer =       require('websocket').server
const WS =                    require('ws')
const Helmet =                require('helmet')
const Dec =                   require('bigdecimal') //https://github.com/iriscouch/bigdecimal.js
const RemoveTrailingZeros =   require('remove-trailing-zeros')
const Tokens =                require('./tokens')
const Tools =                 require('./tools')
const { RateLimiterMemory, RateLimiterUnion } = require('rate-limiter-flexible')

// lowdb init
const order_db: OrderDB =  lowdb(new FileSync<OrderSchema>('db.json'))
const tracking_db: UserDB = lowdb(new FileSync<UserSchema>('websocket.json'))
order_db.defaults({orders: []}).write()
tracking_db.defaults({users: []}).write()
tracking_db.update('users', n => []).write() //empty db on each new run

// Custom VARS. DON'T CHANGE HERE. Change in settings.json file.
var users: Credentials[] = []                      // a list of base64 user/password credentials

// default vars
let cache_duration_default: number = 60
var rpcCache: NodeCache | null = null
var user_settings: UserSettingsConfig = new Map<string, UserSettings>()
const price_url = 'https://api.coinpaprika.com/v1/tickers/nano-nano'
//const price_url2 = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=1567'
//const CMC_API_KEY = 'xxx'
const API_TIMEOUT: number = 10000 // 10sec timeout for calling http APIs
const work_threshold_default: string = 'fffffff800000000'
const work_default_timeout: number = 10 // x sec timeout before trying next delegated work method (only when use_dpow or use_bpow)
const bpow_url: string = 'https://bpow.banano.cc/service/'
const dpow_url: string = 'https://dpow.nanocenter.org/service/'
const work_token_cost = 10 // work_generate will consume x token points
var ws: ReconnectingWebSocket | null = null
var global_tracked_accounts: string[] = [] // the accounts to track in websocket (synced with database)
var websocket_connections: Map<string, connection> = new Map<string, connection>() // active ws connections

let defaultUserSettings: UserSettings | undefined
var user_use_cache: boolean | null = null
var user_use_output_limiter: boolean | null = null
var user_allowed_commands: string[] | null = null
var user_cached_commands: CachedCommands | null = null
var user_limited_commands: LimitedCommands | null = null
var user_log_level: LogLevel | null = null
var dpow_user: string | null = null
var dpow_key: string | null = null
var bpow_user: string | null = null
var bpow_key: string | null = null

// track daily requests and save to a log file (daily stat is reset if the server is restarted)
// ---
var rpcCount: number = 0
var logdata: LogData[] = []
try {
  // read latest count from file
  logdata = JSON.parse(Fs.readFileSync('request-stat.json', 'UTF-8'))
  rpcCount = logdata[logdata.length - 1].count
}
catch(e) {
  console.log("Could not read request-stat.json. Normal for first run.", e)
}

// save the stat file first time
if (logdata.length == 0) {
  try {
    // write log file
    Fs.writeFileSync('request-stat.json', JSON.stringify(logdata, null, 2))
  }
  catch(e) {
    console.log("Could not write request-stat.json", e)
  }
}

// Stat file scheduler
Schedule.scheduleJob('0 0 * * *', () => {
  appendFile(rpcCount)
  rpcCount = 0
  // update latest logdata from file
  try {
    logdata = JSON.parse(Fs.readFileSync('request-stat.json', 'UTF-8'))
  }
  catch(e) {
    console.log("Could not read request-stat.json.", e)
  }
})
function appendFile(count: number) {
  try {
    // append new count entry
    let datestring: string = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '')
    logdata.push({
      date: datestring,
      count: count
    })

    // write updated log
    Fs.writeFileSync('request-stat.json', JSON.stringify(logdata, null, 2))
    logThis("The request stat file was updated!", log_levels.info)
  }
  catch(e) {
    console.log("Could not write request-stat.json", e)
  }
}
// ---

// Read credentials from file
// ---
try {
  const credentials: CredentialSettings = JSON.parse(Fs.readFileSync('creds.json', 'UTF-8'))
  users = credentials.users
}
catch(e) {
  console.log("Could not read creds.json", e)
}
// ---

const loadSettings: () => ProxySettings = () => {
  const defaultSettings: ProxySettings = {
    node_url: "http://[::1]:7076",
    node_ws_url: "ws://127.0.0.1:57000",
    http_port: 9950,
    https_port: 9951,
    websocket_http_port: 9952,
    websocket_https_port: 9953,
    request_path: '/proxy',
    use_auth: false,
    use_slow_down: false,
    use_rate_limiter: false,
    use_cache: false,
    use_http: true,
    use_https: false,
    use_output_limiter: false,
    use_ip_blacklist: false,
    use_tokens: false,
    use_websocket: false,
    use_cors: true,
    use_dpow: false,
    use_bpow: false,
    https_cert: '',
    https_key: '',
    allowed_commands: [],
    cached_commands: new Map<Command, number>(),
    limited_commands: new Map<Command, number>(),
    slow_down: {},
    rate_limiter: {},
    ddos_protection: {},
    ip_blacklist: [],
    proxy_hops: 0,
    websocket_max_accounts: 100,
    cors_whitelist: [],
    log_level: log_levels.none,
    disable_watch_work: false,
  }
  try {
    const settings: ProxySettings = JSON.parse(Fs.readFileSync('settings.json', 'UTF-8'))
    const requestPath = defaultSettings.request_path || settings.request_path
    const normalizedRequestPath = requestPath.startsWith('/') ? requestPath : '/' + requestPath
    const mergedSettings: ProxySettings = {...defaultSettings, ...settings, request_path: normalizedRequestPath }

    // Clone default settings for custom user specific vars, to be used if no auth
    if (!mergedSettings.use_auth) {
      defaultUserSettings = {
        use_cache: mergedSettings.use_cache,
        use_output_limiter: mergedSettings.use_output_limiter,
        allowed_commands: mergedSettings.allowed_commands,
        cached_commands: mergedSettings.cached_commands,
        limited_commands: mergedSettings.limited_commands,
        log_level: mergedSettings.log_level
      }
    }
    return mergedSettings
  }
  catch(e) {
    console.log("Could not read settings.json", e)
    return defaultSettings;
  }
}

// Read settings from file
// ---
const settings: ProxySettings = loadSettings()
// ---

// Read user settings from file, override default settings if they exist for specific users
// ---
try {
  user_settings = JSON.parse(Fs.readFileSync('user_settings.json', 'UTF-8'))
}
catch(e) {
  console.log("Could not read user_settings.json", e)
}

function logObjectEntries(logger: (...data: any[]) => void, title: string, object: any) {
  let log_string = title + "\n"
  for (const [key, value] of Object.entries(object)) {
    if(key) {
      log_string = log_string + key + " : " + value + "\n"
    } else {
      log_string = log_string + " " + value + "\n"
    }
  }
  logger(log_string)
}
// ---
// Log all initial settings for convenience
function logSettings(logger: (...data: any[]) => void) {
  logger("PROXY SETTINGS:\n-----------")
  logger("Node url: " + settings.node_url)
  logger("Websocket url: " + settings.node_ws_url)
  logger("Http port: " + String(settings.http_port))
  logger("Https port: " + String(settings.https_port))
  logger("Request path: " + settings.request_path)
  if (settings.use_websocket) {
    logger("Websocket http port: " + String(settings.websocket_http_port))
    logger("Websocket https port: " + String(settings.websocket_https_port))
    logger("Websocket nax accounts: " + String(settings.websocket_max_accounts))
  }
  logger("Use authentication: " + settings.use_auth)
  logger("Use slow down: " + settings.use_slow_down)
  logger("Use rate limiter: " + settings.use_rate_limiter)
  logger("Use cached requests: " + settings.use_cache)
  logger("Use output limiter: " + settings.use_output_limiter)
  logger("Use IP blacklist: " + settings.use_ip_blacklist)
  logger("Use token system: " + settings.use_tokens)
  logger("Use websocket system: " + settings.use_websocket)
  logger("Use dPoW: " + settings.use_dpow)
  logger("Use bPoW: " + settings.use_bpow)
  logger("Disabled watch_work for process: " + settings.disable_watch_work)
  logger("Listen on http: " + settings.use_http)
  logger("Listen on https: " + settings.use_https)

  logObjectEntries(logger, "Allowed commands:\n-----------\n", settings.allowed_commands)
  if(settings.use_cache)  {
    logObjectEntries(logger, "Cached commands:\n", settings.cached_commands)
  }
  if (settings.use_output_limiter) {
    logObjectEntries(logger, "Limited commands:\n", settings.limited_commands)
  }
  if(settings.use_slow_down) {
    logObjectEntries(logger, "Slow down settings:\n", settings.slow_down)
  }
  if (settings.use_rate_limiter) {
    logObjectEntries(logger, "Rate limiter settings:\n", settings.rate_limiter)
  }
  logObjectEntries(logger, "DDOS protection settings:\n", settings.ddos_protection)

  if (settings.use_ip_blacklist) {
    logObjectEntries(logger, "IPs blacklisted:\n", settings.ip_blacklist)
  }
  if (settings.proxy_hops > 0) {
    logger("Additional proxy servers: " + settings.proxy_hops)
  }
  if (settings.use_cors) {
    if (settings.cors_whitelist.length == 0) {
      logger("Use cors. Any ORIGIN allowed")
    }
    else {
      logObjectEntries(logger, "Use cors. Whitelisted ORIGINs or IPs:\n", settings.cors_whitelist)
    }
  }
  logger("Main log level: " + settings.log_level)

}
logSettings(console.log)

module.exports = {
  logSettings: logSettings
}
// ---

// Read dpow and bpow credentials from file
// ---
if (settings.use_dpow || settings.use_bpow) {
  try {
    const powcreds: PowSettings = JSON.parse(Fs.readFileSync('pow_creds.json', 'UTF-8'))
    if (settings.use_dpow && powcreds.dpow) {
      dpow_user = powcreds.dpow.user
      dpow_key = powcreds.dpow.key
    }
    if (settings.use_bpow && powcreds.bpow) {
      bpow_user = powcreds.bpow.user
      bpow_key = powcreds.bpow.key
    }
  }
  catch(e) {
    console.log("Could not read pow_creds.json", e)
  }
}
// ---


// Periodically check, recover and remove old invactive olders
if (settings.use_tokens) {
  // Each hour
  Schedule.scheduleJob('0 * * * *', () => {
    checkOldOrders()
  })
}

async function checkOldOrders() {
  let now = Math.floor(Date.now()/1000)
  // get all orders older than 60min
  let orders = order_db.get('orders')
    .filter(order => order.timestamp < now - 3600)
    .value()
  // Process all old orders
  //logThis("Checking old orders", log_levels.info)
  orders.forEach(async function(order) {
    // Reset status in case the order was interrupted and set a small nano_amount to allow small pending to create tokens
    order_db.get('orders').find({priv_key: order.priv_key}).assign({order_waiting: false, processing: false, nano_amount: 0.000000001}).write()
    await Tokens.repairOrder(order.address, order_db, settings.node_url)

    // Remove if order has been unprocessed with a timeout for 1 month
    if (order.tokens === 0 && order.order_time_left === 0 && order.hashes.length === 0 && order.timestamp < now - 3600*24*31) {
      logThis("REMOVING ORDER:", log_levels.info)
      logThis(await order_db.get('orders').remove({token_key:order.token_key}).write().toString(), log_levels.info)
    }
  })
}

// Define the proxy app
const app = Express()
app.set('view engine', 'pug')
app.use(Helmet())

// Allow all origin in cors or a whitelist if present
if (settings.use_cors) {
  if (settings.cors_whitelist.length == 0) {
    app.use(Cors())
  }
  else {
    var corsOptions = function (req: Request, callback: (err: Error | null, options?: CorsOptions) => void) {
      if (settings.cors_whitelist.indexOf(req.header('Origin')) !== -1 || settings.cors_whitelist.indexOf(req.ip) !== -1) {
        callback(null, {origin: true}) // reflect (enable) the requested origin in the CORS response
      } else {
        callback(new Error('Not allowed')) // disable CORS for this request
      }
    }
    app.use(Cors(corsOptions))
  }
}

app.use(Express.json())
app.use(Express.static('static'))

// Define the number of proxy hops on the system to detect correct source IP for the filters below
if (settings.proxy_hops > 0) {
  app.set('trust proxy', settings.proxy_hops)
}

// Set up blacklist and use the proxy number defined in the settings. Log only IP if blocked
if (settings.use_ip_blacklist) {
  app.use(IpFilter(settings.ip_blacklist, {logLevel: 'deny', trustProxy: settings.proxy_hops}))
}

// Error handling
app.use((err: Error, req: Request, res: Response, _next: any) => {
  if (err instanceof IpDeniedError) {
    return res.status(401).json({error: 'IP has been blocked'})
  }
  else {
    // @ts-ignore status field does not exist, only return err here?
    return res.status(500).json({error: err.status})
  }
})

// Define authentication service
if (settings.use_auth) {
  app.use(BasicAuth({ authorizer: myAuthorizer }))
}

// Block IP if requesting too much but skipped if a valid token_key is provided (long interval)
if (settings.use_rate_limiter) {
  const limiter1 = new RateLimiterMemory({
    keyPrefix: 'limit1',
    points: settings.rate_limiter.request_limit,
    duration: Math.round(settings.rate_limiter.time_window/1000),
  })

  const rateLimiterMiddleware1 = (req: Request, res: Response, next: (err?: any) => any) => {
    if (settings.use_tokens) {
      // Check if token key exist in DB and have enough tokens, then skip IP block by returning true
      if ('token_key' in req.body && order_db.get('orders').find({token_key: req.body.token_key}).value()) {
        if (order_db.get('orders').find({token_key: req.body.token_key}).value().tokens > 0) {
          next()
          return
        }
      }
      // @ts-ignore overloaded method not found
      if ('token_key' in req.query && order_db.get('orders').find({token_key: req.query.token_key}).value()) {
        // @ts-ignore overloaded method not found
        if (order_db.get('orders').find({token_key: req.query.token_key}).value().tokens > 0) {
          next()
          return
        }
      }
      // Don't count order check here, we do that in the ddos protection step
      if (req.body.action === 'tokenorder_check' || req.query.action === 'tokenorder_check' ||
          req.body.action === 'tokens_buy' || req.query.action === 'tokens_buy' ||
          req.body.action === 'tokenorder_cancel' || req.query.action === 'tokenorder_cancel' ||
          req.body.action === 'tokens_check' || req.query.action === 'tokens_check' ||
          req.body.action === 'tokenprice_check' || req.query.action === 'tokenprice_check') {
        next()
        return
      }
    }
    var points_to_consume = 1
    // work is more costly
    if (req.body.action === 'work_generate') {
      points_to_consume = work_token_cost
    }
    limiter1.consume(req.ip, points_to_consume)
      .then((response: RateLimiterRes) => {
        res.set("X-RateLimit-Limit", settings.rate_limiter.request_limit)
        res.set("X-RateLimit-Remaining", `${settings.rate_limiter.request_limit-response.consumedPoints}`)
        res.set("X-RateLimit-Reset", `${new Date(Date.now() + response.msBeforeNext)}`)
        next()
      })
      .catch((rej: any) => {
        res.set("X-RateLimit-Limit", settings.rate_limiter.request_limit)
        res.set("X-RateLimit-Remaining", `${Math.max(settings.rate_limiter.request_limit-rej.consumedPoints, 0)}`)
        res.set("X-RateLimit-Reset", `${new Date(Date.now() + rej.msBeforeNext)}`)
        res.status(429).send('Max allowed requests of ' + settings.rate_limiter.request_limit + ' reached. Time left: ' + Math.round(rej.msBeforeNext/1000) + 'sec')
      })
   }

   app.use(rateLimiterMiddleware1)
}

// Ddos protection for all requests (short interval)
const limiter2 = new RateLimiterMemory({
  keyPrefix: 'limit2',
  points: settings.ddos_protection.request_limit, // limit each IP to x requests per duration
  duration: Math.round(settings.ddos_protection.time_window/1000), // rolling time window in sec
})

const rateLimiterMiddleware2 = (req: Request, res: Response, next: (err?: any) => any) => {
  limiter2.consume(req.ip, 1)
    .then((response: RateLimiterRes) => {
      next()
    })
    .catch((error?: Error) => {
      res.status(429).send('You are making requests too fast, please slow down!')
    })
 }

 app.use(rateLimiterMiddleware2)

// Limit by slowing down requests
if (settings.use_slow_down) {
  const slow_down_settings = SlowDown({
    windowMs: settings.slow_down.time_window,
    delayAfter: settings.slow_down.request_limit,
    delayMs: settings.slow_down.delay_increment,
    maxDelayMs: settings.slow_down.max_delay,
    // skip limit for certain requests
    skip: function(req, res) {
      if (settings.use_tokens) {
        // Check if token key exist in DB and have enough tokens, then skip IP block by returning true
        if ('token_key' in req.body && order_db.get('orders').find({token_key: req.body.token_key}).value()) {
          if (order_db.get('orders').find({token_key: req.body.token_key}).value().tokens > 0) {
            return true
          }
        }
        // @ts-ignore overloaded method not found
        if ('token_key' in req.query && order_db.get('orders').find({token_key: req.query.token_key}).value()) {
          // @ts-ignore overloaded method not found
          if (order_db.get('orders').find({token_key: req.query.token_key}).value().tokens > 0) {
            return true
          }
        }

        if (req.body.action === 'tokenorder_check' || req.query.action === 'tokenorder_check' ||
            req.body.action === 'tokens_buy' || req.query.action === 'tokens_buy' ||
            req.body.action === 'tokenorder_cancel' || req.query.action === 'tokenorder_cancel' ||
            req.body.action === 'tokens_check' || req.query.action === 'tokens_check' ||
            req.body.action === 'tokenprice_check' || req.query.action === 'tokenprice_check') {
          return true
        }
      }
      return false
    }
  })
  app.use(slow_down_settings)
}

// Set up cache
if (settings.use_cache) {
  rpcCache = new NodeCache( { stdTTL: cache_duration_default, checkperiod: 10 } )
}

// To verify username and password provided via basicAuth. Support multiple users
function myAuthorizer(username: string, password: string) {
  // Set default settings specific for authenticated users
  user_use_cache = settings.use_cache
  user_use_output_limiter = settings.use_output_limiter
  user_allowed_commands = settings.allowed_commands
  user_cached_commands = settings.cached_commands
  user_limited_commands = settings.limited_commands
  user_log_level = settings.log_level

  var valid_user: boolean = false
  for (const [key, value] of Object.entries(users)) {
    if (BasicAuth.safeCompare(username, value.user) && BasicAuth.safeCompare(password, value.password)) {
      valid_user = true

      // Override default settings if exists
      user_settings.forEach((value: UserSettings, key: string, map: UserSettingsConfig) => {
        if(key === username) {
          user_use_cache = value.use_cache
          user_use_output_limiter = value.use_output_limiter
          user_allowed_commands = value.allowed_commands
          user_cached_commands = value.cached_commands
          user_limited_commands = value.limited_commands
          user_log_level = value.log_level
          return;
        }
      })
      break
    }
  }
  return valid_user
}

// Deduct token count for given token_key
function useToken(query: any) {
  let token_key = query.token_key
  // Find token_key in order DB
  if (order_db.get('orders').find({token_key: token_key}).value()) {
    let tokens = order_db.get('orders').find({token_key: token_key}).value().tokens
    if (tokens > 0) {
      var decrease_by = 1
      // work is more costly
      if (query.action === 'work_generate') {
        decrease_by = work_token_cost
      }
      // Count down token by x and store new value in DB
      order_db.get('orders').find({token_key: token_key}).assign({tokens:tokens-decrease_by}).write()
      logThis("A token was used by: " + token_key, log_levels.info)
      return tokens-1
    }
    else {
      return -1
    }
  }
  return -2
}

// Read headers and append result
function appendRateLimiterStatus(res: Response, data: any) {
  let requestsLimit = res.get("X-RateLimit-Limit")
  let requestsRemaining = res.get("X-RateLimit-Remaining")
  let requestLimitReset = res.get("X-RateLimit-Reset")
  if (requestsLimit && requestsRemaining && requestLimitReset) {
    data.requestsLimit = requestsLimit
    data.requestsRemaining = requestsRemaining
    data.requestLimitReset = requestLimitReset
  }
  return data
}

// Update current list of tracked accounts
function updateTrackedAccounts() {
  const confirmation_subscription = {
    "action": "subscribe",
    "topic": "confirmation",
    "ack":true,
    "options": { "all_local_accounts": false,
      "accounts": global_tracked_accounts
    }}
    if(ws != null) {
      ws.send(JSON.stringify(confirmation_subscription))
    }
}

// Log function
function logThis(str: string, level: LogLevel) {
  if (user_log_level == log_levels.info || level == user_log_level) {
    if (level == log_levels.info) {
      console.info(str)
    }
    else {
      console.warn(str)
    }
  }
}

// Compare two hex strings, returns 0 if equal, -1 if A<B and 1 if A>B
function compareHex(a: string | number, b: string | number) {
  a = parseInt('0x' + a, 16)
  b = parseInt('0x' + b, 16)
  let result = 0
  if (a > b) result = 1
  else if(a < b) result = -1
  return result
}

// Determine new multiplier from base difficulty (hexadecimal string) and target difficulty (hexadecimal string). Returns float
function multiplierFromDifficulty(difficulty: string, base_difficulty: string) {
  let big64 = Dec.BigDecimal(2).pow(64)
  let big_diff = Dec.BigDecimal(Dec.BigInteger(difficulty,16))
  let big_base = Dec.BigDecimal(Dec.BigInteger(base_difficulty,16))
  let mode = Dec.RoundingMode.HALF_DOWN()
  return big64.subtract(big_base).divide(big64.subtract(big_diff),32,mode).toPlainString()
}

// Custom error class
class APIError extends Error {

  private code: any

  constructor(code: string, ...params: any[]) {
    super(...params)

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, APIError)
    }
    this.name = 'APIError'
    // Custom debugging information
    this.code = code
  }
}

// Default get requests
if (settings.request_path != '/') {
  app.get('/', async (req: Request, res: Response) => {
    res.render('index', { title: 'RPCProxy API', message: 'Bad API path' })
  })
}

// Process any API requests
app.get(settings.request_path, (req: Request, res: Response) => {
  processRequest(req.query, req, res)
})

// Define the request listener
app.post(settings.request_path, (req: Request, res: Response) => {
  processRequest(req.body, req, res)
})

async function processRequest(query: any, req: Request, res: Response) {
  if (query.action !== 'tokenorder_check') {
    logThis('RPC request received from ' + req.ip + ': ' + query.action, log_levels.info)
    rpcCount++
  }

  if (settings.use_tokens) {
    // Initiate token purchase
    var token_key = ""
    if (query.action === 'tokens_buy') {
      var token_amount = 0
      if ('token_amount' in query) {
        token_amount = Math.round(query.token_amount)
      }
      else {
        return res.status(500).json({ error: 'The amount of tokens (token_amount) to purchase must be provided'})
      }
      if ('token_key' in query) {
        token_key = query.token_key
      }

      let payment_request = await Tokens.requestTokenPayment(token_amount, token_key, order_db, settings.node_url)

      res.json(payment_request)
      return
    }

    // Verify order status
    if (query.action === 'tokenorder_check') {
      token_key = ""
      if ('token_key' in query) {
        token_key = query.token_key
        let status = await Tokens.checkOrder(token_key, order_db)
        return res.json(status)
      }
      else {
        return res.status(500).json({ error: 'No token key provided'})
      }
    }

    // Claim back private key and replace the account
    if (query.action === 'tokenorder_cancel') {
      token_key = ""
      if ('token_key' in query) {
        token_key = query.token_key
        let status = await Tokens.cancelOrder(token_key, order_db)
        return res.json(status)
      }
      else {
        return res.status(500).json({ error: 'No token key provided'})
      }
    }

    // Verify order status
    if (query.action === 'tokens_check') {
      token_key = ""
      if ('token_key' in query) {
        token_key = query.token_key
        let status = await Tokens.checkTokens(token_key, order_db)
        return res.json(status)
      }
      else {
        return res.status(500).json({ error: 'No token key provided'})
      }
    }
  }

  // Check token price
  if (query.action === 'tokenprice_check') {
    let status = await Tokens.checkTokenPrice()
    return res.json(appendRateLimiterStatus(res, status))
  }

  // Block non-allowed RPC commands
  if (!query.action || user_allowed_commands?.indexOf(query.action) === -1) {
    logThis('RPC request is not allowed: ' + query.action, log_levels.info)
    return res.status(500).json({ error: `Action ${query.action} not allowed`})
  }

  // Decrease user tokens and block if zero left
  var tokens_left: number | null = null
  if (settings.use_tokens) {
    if ('token_key' in query) {
      let status = useToken(query)
      if (status === -1) {
        return res.status(500).json({ error: 'You have no more tokens to use!'})
      }
      else if (status === -2) {
        return res.status(500).json({ error: 'Provided key does not exist!'})
      }
      else {
        tokens_left = status
      }
    }
  }

  // Respond directly if non-node-related request
  //  --
  if (query.action === 'price') {
    try {
      // Use cached value first
      const cachedValue = rpcCache?.get('price')
      if (Tools.isValidJson(cachedValue)) {
        logThis("Cache requested: " + 'price', log_levels.info)
        if (tokens_left != null) {
          // @ts-ignore dont know what the value is here
          cachedValue.tokens_total = tokens_left
        }
        return res.json(appendRateLimiterStatus(res, cachedValue))
      }

      let data = await Tools.getData(price_url, API_TIMEOUT)

      // Store the price in cache for 10sec
      if (!rpcCache?.set('price', data, 10)) {
        logThis("Failed saving cache for " + 'price', log_levels.warning)
      }
      //res.json({"Price USD":data.data["1567"].quote.USD.price}) // sending back json price response (CMC)
      //res.json({"Price USD":data.quotes.USD.price}) // sending back json price response (Coinpaprika)
      if (tokens_left != null) {
        data.tokens_total = tokens_left
      }
      res.json(appendRateLimiterStatus(res, data)) // sending back full json price response (Coinpaprika)
    }
    catch(err) {
      res.status(500).json({error: err.toString()})
    }
    return
  }

  if (query.action === 'mnano_to_raw') {
    if ('amount' in query) {
      let amount = Tools.MnanoToRaw(query.amount)
      res.json(appendRateLimiterStatus(res, {"amount":amount}))
    }
    else {
      return res.status(500).json({ error: 'Amount not provided!'})
    }
    return
  }

  if (query.action === 'mnano_from_raw') {
    if ('amount' in query) {
      let amount = Tools.rawToMnano(query.amount)
      res.json(appendRateLimiterStatus(res, {"amount":amount}))
    }
    else {
      return res.status(500).json({ error: 'Amount not provided!'})
    }
    return
  }

  // Force no watch_work (don't want the node to perform pow)
  if (settings.disable_watch_work) {
    if (query.action === 'process') {
      query.watch_work = 'false'
    }
  }

  // Handle work generate via dpow and/or bpow
  if (query.action === 'work_generate' && (settings.use_dpow || settings.use_bpow)) {
    if ('hash' in query) {
      var bpow_failed = false
      if (!("difficulty" in query)) {
        // Use cached value first
        const cachedValue = rpcCache?.get('difficulty')
        if (Tools.isValidJson(cachedValue)) {
          logThis("Cache requested: " + 'difficulty', log_levels.info)
          query.difficulty = cachedValue
        }
        else {
          // get latest difficulty from network
          let data = await Tools.postData({"action":"active_difficulty"}, settings.node_url, API_TIMEOUT)
          if ('network_current' in data) {
            // Store the difficulty in cache for 60sec
            if (!rpcCache?.set('difficulty', data.network_current, 60)) {
              logThis("Failed saving cache for " + 'difficulty', log_levels.warning)
            }
            query.difficulty = data.network_current
            logThis("New difficulty: " + query.difficulty, log_levels.info)
          }
          else {
            query.difficulty = work_threshold_default
            logThis("Using default difficulty: " + query.difficulty, log_levels.info)
          }
        }
        if (compareHex(work_threshold_default, query.difficulty)) {
          query.difficulty = work_threshold_default
        }
      }
      if (!("timeout" in query)) {
        query.timeout = work_default_timeout
      }

      // Try bpow first
      if (settings.use_bpow) {
        logThis("Requesting work using bpow with diff: " + query.difficulty, log_levels.info)
        query.user = bpow_user
        query.api_key = bpow_key

        try {
          let data = await Tools.postData(query, bpow_url, work_default_timeout*1000*2)
          data.difficulty = query.difficulty
          data.multiplier = RemoveTrailingZeros(multiplierFromDifficulty(data.difficulty, work_threshold_default).toString())
          if (tokens_left != null) {
            data.tokens_total = tokens_left
          }
          // if bpow time out
          if ('error' in data) {
            logThis("bPoW failed: " + data.error, log_levels.warning)
          }
          if (('error' in data) || !('work' in data)) {
            bpow_failed = true
            if (!settings.use_dpow) {
              res.json(appendRateLimiterStatus(res, data)) // forward error if not retrying with dpow
              return
            }
          }
          else if ('work' in data) {
            res.json(appendRateLimiterStatus(res, data)) // sending back successful json response
            return
          }
        }
        catch(err) {
          bpow_failed = true
          if (!settings.use_dpow) {
            res.status(500).json({error: err.toString()})
            return
          }
          logThis("Bpow connection error: " + err.toString(), log_levels.warning)
        }
      }
      // Use dpow only if not already used bpow or bpow timed out
      if (settings.use_dpow && (!settings.use_bpow || bpow_failed)) {
        logThis("Requesting work using dpow with diff: " + query.difficulty, log_levels.info)
        query.user = dpow_user
        query.api_key = dpow_key

        try {
          let data = await Tools.postData(query, dpow_url, work_default_timeout*1000*2)
          data.difficulty = query.difficulty
          data.multiplier = RemoveTrailingZeros(multiplierFromDifficulty(data.difficulty, work_threshold_default).toString())
          if (tokens_left != null) {
            data.tokens_total = tokens_left
          }
          if ('error' in data) {
            logThis("dPoW failed: " + data.error, log_levels.warning)
          }
          res.json(appendRateLimiterStatus(res, data)) // sending back json response (regardless if timeout error)
        }
        catch(err) {
          res.status(500).json({error: err.toString()})
          logThis("Dpow connection error: " + err.toString(), log_levels.warning)
        }
      }
    }
    else {
      return res.status(500).json({ error: 'Hash not provided!'})
    }
    return
  }

  // ---

  // Read cache for current request action, if there is one
  if (user_use_cache) {
    const value: number | undefined = user_cached_commands?.get(query.action)
    if(value !== undefined) {
      const cachedValue = rpcCache?.get(query.action)
      if (Tools.isValidJson(cachedValue)) {
        logThis("Cache requested: " + query.action, log_levels.info)
        if (tokens_left != null) {
          // @ts-ignore what is type of cachedValue?
          cachedValue.tokens_total = tokens_left
        }
        return res.json(appendRateLimiterStatus(res, cachedValue))
      }
    }
  }

  // Limit response count (if count parameter is provided)
  if (user_use_output_limiter) {
    const value: number | undefined = user_limited_commands?.get(query.action)
    if(value !== undefined) {
      if (parseInt(query.count) > value || !("count" in query)) {
        query.count = value
        if (parseInt(query.count) > value) {
          logThis("Response count was limited to " + value.toString(), log_levels.info)
        }
      }
    }
  }

  // Send the request to the Nano node and return the response
  try {
    let data = await Tools.postData(query, settings.node_url, API_TIMEOUT)
    // Save cache if applicable
    if (settings.use_cache) {
      const value: number | undefined = user_cached_commands?.get(query.action)
      if(value !== undefined) {
        if (!rpcCache?.set(query.action, data, value)) {
          logThis("Failed saving cache for " + query.action, log_levels.warning)
        }
      }
    }
    if (tokens_left != null) {
      data.tokens_total = tokens_left
    }
    res.json(appendRateLimiterStatus(res, data)) // sending back json response
  }
  catch(err) {
    res.status(500).json({error: err.toString()})
    logThis("Node conection error: " + err.toString(), log_levels.warning)
  }
}

var websocket_servers = []
// Create an HTTP service
if (settings.use_http && test_override_http) {
  Http.createServer(app).listen(settings.http_port, function() {
    console.log("Http server started on port: " + settings.http_port)
  })

  // websocket
  if (settings.use_websocket) {
    var ws_http_server = Http.createServer(function(request: IncomingMessage, response: ServerResponse) {
      response.writeHead(404)
      response.end()
    })
    ws_http_server.listen(settings.websocket_http_port, function() {
      console.log('Websocket server is listening on port ' + settings.websocket_http_port)
    })
    websocket_servers.push(ws_http_server)
  }
}

// Create an HTTPS service
if (settings.use_https) {
  // Verify that cert files exists
  var cert_exists = false
  var key_exists = false
  Fs.access(settings.https_cert, Fs.F_OK, (err: ErrnoException) => {
    if (err) {
      console.log("Warning: Https cert file does not exist!")
    }
    cert_exists = true
  })
  Fs.access(settings.https_key, Fs.F_OK, (err: ErrnoException) => {
    if (err) {
      console.log("Warning: Https key file does not exist!")
    }
    key_exists = true
  })
  if (cert_exists && key_exists) {
    var https_options = {
      cert: Fs.readFileSync(settings.https_cert),
      key: Fs.readFileSync(settings.https_key)
    }

    Https.createServer(https_options, app).listen(settings.https_port, function() {
      console.log("Https server started on port: " + settings.https_port)
    })

    // websocket
    if (settings.use_websocket) {
      var ws_https_server = Https.createServer(https_options, function(request: IncomingMessage, response: ServerResponse) {
        response.writeHead(404)
        response.end()
      })
      ws_https_server.listen(settings.websocket_https_port, function() {
        console.log('Websocket server is listening on port ' + settings.websocket_https_port)
      })
      websocket_servers.push(ws_https_server)
    }
  }
  else {
    console.log("Warning: Will not listen on https!")
  }
}

// WEBSOCKET SERVER
//---------------------
if (settings.use_websocket) {
  let wsServer: WSServer = new WebSocketServer({
    httpServer: websocket_servers,
    autoAcceptConnections: false
  })

  // websocket ddos protection settings
  const websocket_limiter = new RateLimiterMemory({
    keyPrefix: 'limit_websocket',
    points: settings.ddos_protection.request_limit,
    duration: Math.round(settings.ddos_protection.time_window/1000),
  })

  wsServer.on('request', async function(request: WSRequest) {
    if (!originIsAllowed(request.origin)) {
      // Make sure we only accept requests from an allowed origin
      request.reject()
      //logThis('Connection from origin ' + request.origin + ' rejected.', log_levels.info)
      return
    }

    let remote_ip = request.remoteAddress
    logThis('Websocket Connection requested from: ' + remote_ip, log_levels.info)

    // Black list protection
    if (settings.ip_blacklist.includes(remote_ip)) {
      request.reject()
      return
    }

    // DDOS Protection
    try {
      await websocket_limiter.consume(remote_ip, 1) // consume 1 point
    }
    // max amount of connections reached
    catch (rlRejected) {
      if (rlRejected instanceof Error) {
        throw rlRejected;
      } else {
        request.reject()
        return
      }
    }
    try {
      var connection = request.accept()
    } catch (error) {
      logThis('Bad protocol from connecting client', log_levels.info)
      return
    }

    connection.on('message', function(message: IMessage) {
      if (message.type === 'utf8') {
          //console.log('Received Message: ' + message.utf8Data + ' from ' + remote_ip)
          try {
            // @ts-ignore utf8Data might be undefined AND don't know what type to expect here
            let msg = JSON.parse(message.utf8Data)
            // new subscription
            if ('action' in msg && 'topic' in msg && msg.action === 'subscribe') {
              if (msg.topic === 'confirmation') {
                if ('options' in msg && 'accounts' in msg.options) {
                  if (msg.options.accounts.length <= settings.websocket_max_accounts) {
                    // check if new unique accounts + existing accounts exceed max limit
                    // get existing tracked accounts
                    let current_user = tracking_db.get('users').find({ip: remote_ip}).value()
                    var current_tracked_accounts = {} //if not in db, use empty dict
                    if (current_user !== undefined) {
                      current_tracked_accounts = current_user.tracked_accounts
                    }

                    // count new accounts that are not already tracked
                    let unique_new = 0
                    msg.options.accounts.forEach(function(address: string) {
                      var address_exists = false
                      for (const [key] of Object.entries(current_tracked_accounts)) {
                        if (key === address)  {
                          address_exists = true
                        }
                      }
                      if (!address_exists) {
                        unique_new++
                      }
                    })
                    if (unique_new + Object.keys(current_tracked_accounts).length <= settings.websocket_max_accounts) {
                      // save connection to global dicionary to reuse when getting messages from the node websocket
                      websocket_connections.set(remote_ip, connection)

                      // mirror the subscription to the real websocket
                      var tracking_updated = false
                      msg.options.accounts.forEach(function(address: string) {
                        if (trackAccount(connection, address)) {
                          tracking_updated = true
                        }
                      })
                      if (tracking_updated) {
                        updateTrackedAccounts() //update the websocket subscription
                      }
                      connection.sendUTF(JSON.stringify({'ack':'subscribe','id':'id' in msg ? msg.id:""}, null, 2))
                    }
                    else {
                      connection.sendUTF(JSON.stringify({'error':'Too many accounts subscribed. Max is ' + settings.websocket_max_accounts}, null, 2))
                    }
                  }
                  else {
                    connection.sendUTF(JSON.stringify({'error':'Too many accounts subscribed. Max is ' + settings.websocket_max_accounts}, null, 2))
                  }
                }
                else {
                  connection.sendUTF(JSON.stringify({'error':'You must provide the accounts to track via the options parameter'}, null, 2))
                }
              }
            }
            else if ('action' in msg && 'topic' in msg && msg.action === 'unsubscribe') {
              if (msg.topic === 'confirmation') {
                logThis('User unsubscribed from confirmation: ' + remote_ip, log_levels.info)
                tracking_db.get('users').find({ip: remote_ip}).assign({'tracked_accounts':[]}).write()
              }
            }
          }
          catch (e) {
            //console.log(e)
          }
      }
    })
    connection.on('close', function(reasonCode, description) {
      logThis('Websocket disconnected for: ' + remote_ip, log_levels.info)
      // clean up db and dictionary
      tracking_db.get('users').remove({ip: remote_ip}).write()
      websocket_connections.delete(remote_ip)
    })
  })
}

function originIsAllowed(origin: string) {
  // put logic here to detect whether the specified origin is allowed.
  // TODO
  return true
}

// Start websocket subscription for an address
function trackAccount(connection: connection, address: string) {
  if (!Tools.validateAddress(address)) {
    return false
  }
  let remote_ip = connection.remoteAddress
  // get existing tracked accounts
  let current_user = tracking_db.get('users').find({ip: remote_ip}).value()
  var current_tracked_accounts: Map<string, TrackedAccount> = new Map<string, TrackedAccount>() //if not in db, use empty dict
  if (current_user !== undefined) {
    current_tracked_accounts = current_user.tracked_accounts
  }

  // check if account is not already tracked
  var address_exists = false
  for (const [key] of Object.entries(current_tracked_accounts)) {
    if (key === address)  {
      address_exists = true
    }
  }

  // start tracking new address
  if (!address_exists) {
    current_tracked_accounts.set(address, {timestamp: Math.floor(Date.now()/1000)}) // append new tracking

    // add user and tracked account to db
    if (current_user === undefined) {
      const userinfo: User = {
        ip : remote_ip,
        tracked_accounts : current_tracked_accounts
      }
      tracking_db.get('users').push(userinfo).write()
    }
    // update existing user
    else {
      tracking_db.get('users').find({ip: remote_ip}).assign({tracked_accounts: current_tracked_accounts}).write()
    }

    // check if account is already tracked globally or start tracking
    var tracking_exists = false
    global_tracked_accounts.forEach(function(tracked_address) {
      if (tracked_address === address) {
        tracking_exists = true
      }
    })
    if (!tracking_exists) {
      global_tracked_accounts.push(address)
      return true
    }
  }
  return false
}

//WEBSOCKET CLIENT FOR NANO NODE
// Create a reconnecting WebSocket.
// we wait a maximum of 2 seconds before retrying.
if (settings.use_websocket) {
  let newWebSocket: ReconnectingWebSocket = new ReconnectingWebSocket(settings.node_ws_url, [], {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: Infinity,
    maxReconnectionDelay: 8000,
    minReconnectionDelay: 3000
  })

  // A tracked account was detected
  newWebSocket.onmessage = (msg: MessageEvent) => {
    let data_json = JSON.parse(msg.data)

    // Check if the tracked account belongs to a user
    if (data_json.topic === "confirmation") {
      let observed_account = data_json.message.account
      let observed_link = data_json.message.block.link_as_account

      // FOR ACCOUNT TRACKING
      let tracked_accounts = tracking_db.get('users').value()
      // loop all existing tracked accounts as subscribed to by users
      tracked_accounts.forEach(async function(user) {
        if ("tracked_accounts" in user && "ip" in user) {
          // loop all existing accounts for that user
          for (const [key] of Object.entries(user.tracked_accounts)) {
            if (key === observed_account || key === observed_link) {
              // send message to each subscribing user for this particular account
              logThis('A tracked account was pushed to client: ' + key, log_levels.info)
              websocket_connections.get(user.ip)?.sendUTF(msg.data)
            }
          }
        }
      })
    }
    else if ("ack" in data_json) {
      if (data_json.ack === "subscribe") {
        logThis("Websocket subscription updated", log_levels.info)
      }
    }
  }

  // As soon as we connect, subscribe to confirmations (as of now there are none while we start up the server)
  newWebSocket.onopen = () => {
    logThis("Node websocket is open", log_levels.info)
    updateTrackedAccounts()
  }
  newWebSocket.onclose = () => {
    logThis("Node websocket is closed", log_levels.info)
  }
  newWebSocket.onerror = (e: ErrorEvent) => {
    logThis("Main websocket: " + e.error, log_levels.warning)
  }
  ws = newWebSocket
}
