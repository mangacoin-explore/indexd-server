let debug = require('debug')('express')
let bitcoin = require('bitcoinjs-lib')
let bodyParser = require('body-parser')
let express = require('express')
let parallel = require('run-parallel')
let rpc = require('./rpc')
let types = require('indexd/types')
let bech32 = require('bech32')

function Hex256bit(value) {
  return typeof value === 'string' &&
    /^([0-9a-f]{2})+$/i.test(value) &&
    value.length === 64
}

module.exports = function initialize(adapter, opts) {
  let router = new express.Router()
  let networkName = 'mainnet'
  let network = {
    messagePrefix: '\x19Mangacoin Signed Message:\n',
    bip32: {
      public: 0x0488b21e,
      private: 0x0488ade4
    },
    pubKeyHash: 110,
    scriptHash: 97,
    wif: 176,
    bech32: "manga"
  };

  if (opts.testnet) {
    network = {
      messagePrefix: '\x19Mangacoin Signed Message:\n',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 127,
      scriptHash: 132,
      wif: 239,
      bech32: "tmanga"
    };
    networkName = 'testnet'
  } else if (opts.regtest) {
    network = {
      messagePrefix: '\x19Mangacoin Signed Message:\n',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 127,
      scriptHash: 132,
      wif: 239,
      bech32: "tmanga"
    };
    networkName = 'regtest'
  }

  function respond(req, res, err, result) {
    if (err) debug('ERR: ' + req.path, err)
    if (err) {
      let errMsg
      if (typeof err === 'number') {
        res.status(err)
      } else {
        if (typeof err === 'object' && err.message) {
          res.status((err.status && typeof err.status === 'number') ? err.status : 400)
          errMsg = '' + err.message
        } else {
          res.status(400)
          errMsg = '' + err
        }
      }
      res.json({
        error: errMsg
      })
      return res.end()
    }

    res.status(200)
    if (result !== undefined) {
      if (typeof result === 'string') res.send(result)
      else if (Buffer.isBuffer(result)) res.send(result)
      else res.json(result)
    }
    res.end()
  }

  function resolveHeight(heightQuery) {
    let height = parseInt(heightQuery)
    if (!Number.isFinite(height)) height = 0
    return height
  }

  router.get('/status', (req, res) => {
    parallel({
      localtip: (cb) => adapter.blockchain.db.get(types.tip, {}, cb),
      bitcoinheight: (cb) => rpc('getblockcount', [], cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let localheight = results.localtip ? results.localtip.height : 0
      let bitcoinheight = results.bitcoinheight
      status = {
        chainBlock: bitcoinheight,
        indexBlock: localheight,
        network: networkName,
        blocksBehind: (bitcoinheight && localheight) ? (bitcoinheight - localheight) : null,
        ready: bitcoinheight && localheight && (bitcoinheight - localheight) <= 1,
      }

      respond(req, res, null, status)
    })
  })

  function addressToScriptId(address) {
    let script = null

    if (address.startsWith(network.bech32)) {
      // Regtest starts with 'bc' too
      let b32res = bech32.decode(address)
      let witnessData = bech32.fromWords(b32res.words.slice(1))
      let witnessOpcodes = [0, 0x14]
      script = Buffer.from(witnessOpcodes.concat(witnessData))
    } else {
      script = bitcoin.address.toOutputScript(address, network)
    }

    return bitcoin.crypto.sha256(script).toString('hex')
  }

  router.get('/a/:address/utxos', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) {
      return respond(req, res, e)
    }

    let height = resolveHeight(req.query.height)

    // add confirmations to utxos
    parallel({
      tip: (cb) => adapter.blockchain.db.get(types.tip, {}, cb),
      utxos: (cb) => adapter.utxosByScriptId(scId, height, cb)
    }, (err, results) => {
      if (err) return respond(req, res, err)

      let tipHeight = results.tip.height
      let utxos = []

      Object.keys(results.utxos).forEach(function (key) {
        let utxo = results.utxos[key]
        let height = utxo.height
        if (height && height <= tipHeight) {
          utxo.confirmations = tipHeight - height + 1
        } else {
          utxo.confirmations = 0
        }

        // we don't care about the scId
        delete utxo.scId

        utxos.push(utxo)
      })
      respond(req, res, null, utxos)
    })
  })

  router.get('/a/:address/txs', (req, res) => {
    let scId
    try {
      scId = addressToScriptId(req.params.address)
    } catch (e) {
      return respond(req, res, e)
    }

    let height = resolveHeight(req.query.height)
    let verbose = req.query.verbose ? true : false

    adapter.transactionIdsByScriptId(scId, height, (err, txIdSet) => {
      if (err) return respond(req, res, err)

      let tasks = {}
      for (let txId in txIdSet) {
        tasks[txId] = (next) => rpc('getrawtransaction', [txId, verbose], next)
      }

      parallel(tasks, (err, result) => respond(req, res, err, result))
    })
  })

  return router
}