const cors = require('cors')
const {Long} = require('mongodb')
const {corsWhitelist} = require('../app.config')
const apiCache = require('./api-cache')
const billing = require('./billing')

//increase stack trace depth
Error.stackTraceLimit = 16

const corsMiddleware = {
    whitelist: cors(function (req, callback) {
        const origin = req.header('Origin')
        if (!origin)
            return callback(null, true)
        if (corsWhitelist.includes(origin) || req.billingProcessed)
            return callback(null, true)
        const e = new Error(`Origin ${origin} is blocked by CORS.`)
        e.isBlockedByCors = true
        callback(e)
    }),
    open: cors()
}

function responseReplacer(key, value) {
    if (typeof value === 'bigint' || value instanceof Long)
        return value.toString()
    return value
}

module.exports = {
    /**
     * Register API route.
     * @param {object} app - Express app instance.
     * @param {string} route - Relative route path.
     * @param {object} options - Additional options.
     * @param {'get'|'post'|'put'|'delete'} [options.method] - Route prefix. Default: 'get'
     * @param {string} [options.prefix] - Route prefix. Default: '/explorer/:network/'
     * @param {('whitelist'|'open')} [options.cors] - CORS headers to set. Default: 'whitelist'.
     * @param {string} [options.cache] - Caching bucket name or '' to disable caching. Default: ''.
     * @param {object} [options.headers] - Additional response headers. Default: {}.
     * @param {string} [options.billingCategory] - Billing category name.
     * @param {[function]} [options.middleware] - Request middleware to use.
     * @param {routeHandler} handler - Request handler.
     */
    registerRoute(app, route, options, handler) {
        const {
            method = 'get',
            prefix = '/explorer/:network/',
            cors = 'whitelist',
            cache = '',
            headers,
            billingCategory,
            middleware = []
        } = options

        middleware.unshift(corsMiddleware[cors])
        if (billingCategory) {
            middleware.unshift((req, res, next) => {
                const charged = billing.charge(req.headers, billingCategory)
                if (charged) {
                    req.billingProcessed = true
                    return next()
                }
                res.status(402)
                res.send('Payment Required')
            })
        }

        if (cache) {
            middleware.push(apiCache.cache(cache))
        }
        app[method](prefix + route, middleware, function (req, res) {
            //TODO: combine request path parameters with query params and pass a single plain object instead of req
            let promise
            try {
                promise = handler(req)
                if (typeof promise.then !== 'function') {
                    promise = Promise.resolve(promise)
                }
            } catch (e) {
                promise = Promise.reject(e)
            }
            promise
                .then(data => {
                    if (!data) data = {}
                    if (headers) {
                        res.set(headers)
                        //send raw data if content-type was specified
                        if (headers['content-type'] && headers['content-type'] !== 'application/json') {
                            res.send(data)
                            return
                        }
                    }
                    res.set({'content-type': 'application/json'})
                    res.send(JSON.stringify(data, responseReplacer, req.query.prettyPrint !== undefined ? '  ' : undefined))
                })
                .catch(err => {
                    if (err.isBlockedByCors) return res.status(403).json({error: err.text, status: 403})
                    if (err.status) return res.status(err.status).json({error: err.message, status: err.status})
                    //unhandled error
                    err.message = req.url + ' \n' + err.message
                    console.error(err)
                    res.status(500).json({error: 'Internal server error', status: 500})
                })
        })
        app.options(prefix + route, middleware, function (req, res) {
            res.send(method.toUpperCase())
        })
    },
    /**
     * Return 301 permanent redirect for a route.
     * @param {object} app - Express app
     * @param {string} from - Path to redirect.
     * @param {string|function} to - New destination.
     * @param {{method: ('get'|'set'|'put'|'delete')}} [options] - Extra options.
     */
    permanentRedirect(app, from, to, options = {method: 'get'}) {
        app.get(from, function (req, res) {
            const dest = typeof to === 'function' ? to(req, res) : to
            res.set('Access-Control-Allow-Origin', '*')
            res.set('location', dest)
            res.status(301).send()
        })
        app.options(from, function (req, res) {
            res.set('Access-Control-Allow-Origin', '*')
            res.send(options.method.toUpperCase())
        })
    }
}


/**
 * Route handler callback.
 * @callback routeHandler
 * @param {{params: object, query: object, path: string}} req - Request object.
 */