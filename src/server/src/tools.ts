import Fetch, {Response} from 'node-fetch'
const BigInt =  require('big-integer')
const Nano =    require('nanocurrency')

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

// Functions to be required from another file
module.exports = {
  // Get data from URL. let data = await getData("url", TIMEOUT)
  getData: async function (server: string, timeout: number) {
    let options: any = {
      method: 'get',
      timeout: timeout,
    }

    let promise = new Promise(async (resolve, reject) => {
        // https://www.npmjs.com/package/node-fetch
        Fetch(server, options)
          .then(checkStatus)
          .then(res => res.json())
          .then(json => resolve(json))
          .catch(err => reject(new Error('Connection error: ' + err)))
    })
    return await promise // return promise result when finished instead of returning the promise itself, to avoid nested ".then"
  },
  // Post data, for example to RPC node. let data = await postData({"action":"block_count"}, "url", TIMEOUT)
  postData: async function (data: any, server: string, timeout: number) {
    let options: any = {
      method: 'post',
      body:    JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
      timeout: timeout,
    }

    let promise = new Promise(async (resolve, reject) => {
        // https://www.npmjs.com/package/node-fetch
        Fetch(server, options)
          .then(checkStatus)
          .then(res => res.json())
          .then(json => resolve(json))
          .catch(err => reject(new Error('Connection error: ' + err)))
    })
    return await promise // return promise result when finished instead of returning the promise itself, to avoid nested ".then"
  },
  // Check if a string is a valid JSON
  isValidJson: function (obj: any) {
    if (obj != null) {
      try {
          JSON.parse(JSON.stringify(obj))
          return true
      } catch (e) {
        return false
      }
    }
    else  {
      return false
    }
  },
  // Add two big integers
  bigAdd: function (input: string, value: string): string {
    let insert = BigInt(input)
    let val = BigInt(value)
    return insert.add(val).toString()
  },
  rawToMnano: function (input: string) {
    return isNumeric(input) ? Nano.convert(input, {from: Nano.Unit.raw, to: Nano.Unit.NANO}) : 'N/A'
  },
  MnanoToRaw: function (input: string) {
    return isNumeric(input) ? Nano.convert(input, {from: Nano.Unit.NANO, to: Nano.Unit.raw}) : 'N/A'
  },
  // Validate nano address, both format and checksum
  validateAddress: function (address: string) {
    return Nano.checkAddress(address)
  },
}

function checkStatus(res: Response) {
    if (res.ok) { // res.status >= 200 && res.status < 300
        return res
    } else {
        throw new APIError(res.statusText)
    }
}

// Check if numeric string
function isNumeric(val: string) {
  //numerics and last character is not a dot and number of dots is 0 or 1
  let isnum = /^-?\d*\.?\d*$/.test(val)
  if (isnum && String(val).slice(-1) !== '.') {
    return true
  }
  else {
    return false
  }
}
