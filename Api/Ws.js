import {message} from 'antd';
import {Parse} from 'foundation';
import Auth from './../Auth';
import Crypto from './Crypto';

const ApiSave = (key, res) => {
  try {
    localStorage[key] = Parse.jsonEncode(res);
    localStorage[`${key}#EXPIRE`] = (new Date()).getTime() + 6e4;
  } catch (e) {
    localStorage.clear();
  }
};
const ApiLoad = (key) => {
  if (localStorage[`${key}#EXPIRE`] === undefined || localStorage[`${key}#EXPIRE`] < (new Date()).getTime()) {
    localStorage[key] = null;
  }
  return localStorage[key] ? Parse.jsonDecode(localStorage[key]) : null;
};

const ApiSocket = { /* host: obj */};
const Socket = {
  stack: {},
  stackIndex: 0,
  stackLimit: 1000,
  queue: [],
  state: {
    CONNECTING: 0, // 连接尚未建立
    OPEN: 1, // 链接已经建立
    CLOSING: 2, // 连接正在关闭
    CLOSED: 3, // 连接已经关闭或不可用
  },
  build: (conf) => {
    const host = conf.host;
    if (typeof ApiSocket[host] !== 'undefined') {
      ApiSocket[host].onopen = null;
      ApiSocket[host].onerror = null;
      ApiSocket[host].onclose = null;
      ApiSocket[host].onmessage = null;
      ApiSocket[host].close();
      ApiSocket[host] = null;
    }
    ApiSocket[host] = new WebSocket(host);
    ApiSocket[host].onopen = () => {
      console.log('connection');
      console.log((new Date()).getMinutes() + ':' + (new Date()).getSeconds());
      message.destroy();
      message.info('connect server success');
      if (Socket.queue.length > 0) {
        let q = Socket.queue.shift();
        while (q !== undefined) {
          ApiSocket[host].send(Crypto.encode(q, conf.crypto));
          q = Socket.queue.shift();
        }
      }
    };
    ApiSocket[host].onmessage = (msg) => {
      const result = Crypto.is(conf.crypto) ? Crypto.decode(msg.data, conf.crypto) : Parse.jsonDecode(msg.data);
      let stack = result.stack || null;
      if (stack === null) {
        message.error('stack error');
        return;
      }
      stack = stack.split('#STACK#');
      const stackIndex = stack[0];
      const stackKey = stack[1];
      if (typeof Socket.stack[stackIndex].then !== 'function') {
        message.error('stack then error');
        return;
      }
      Socket.stack[stackIndex].apis[stackKey] = result;
      let totalFinish = true;
      let hasNotAuth = false;
      let response = [];
      Object.entries(Socket.stack[stackIndex].apis)
        .forEach(([key, finish]) => {
          if (finish === false) {
            totalFinish = false;
          } else {
            const res = Socket.stack[stackIndex].apis[key];
            if (typeof res === 'object') {
              response.push(res);
              if (typeof res.code === 'number' && res.code === 403) {
                hasNotAuth = true;
              } else if (conf.refresh === false && typeof res.code === 'number' && key.length < Ws.CacheKeyLimit && res.code === 200) {
                ApiSave(key, res);
              }
            } else {
              response.push({code: 500, response: 'api error', data: null});
            }
          }
        });
      if (totalFinish === true) {
        if (hasNotAuth === true) {
          if (Auth.getUid() !== undefined) {
            message.error(Ws.Tips403, 2.00, () => {
              location.href = Ws.PathLogin;
            });
          } else {
            message.warning('operation not permission');
          }
        } else {
          const then = Socket.stack[stackIndex].then;
          if (response.length === 1) {
            response = response[0];
          }
          then(response);
        }
      }
    };
    ApiSocket[host].onerror = () => {
      console.log('error');
      Socket.build(conf);
    };
    ApiSocket[host].onclose = () => {
      console.log('close');
      Socket.build(conf);
    };
  },
  send: (conf, params) => {
    const host = conf.host;
    if (ApiSocket[host] === undefined || ApiSocket[host] === null) {
      Socket.build(conf);
    }
    if (ApiSocket[host] !== null) {
      if (ApiSocket[host].readyState === Socket.state.OPEN) {
        ApiSocket[host].send(Crypto.encode(params, conf.crypto));
      } else if (ApiSocket[host].readyState === Socket.state.CONNECTING) {
        message.loading('connect server trying');
        Socket.queue.push(params);
      } else if (ApiSocket[host].readyState === Socket.state.CLOSING) {
        message.warning('connect server closing');
        Socket.queue.push(params);
      } else if (ApiSocket[host].readyState === Socket.state.CLOSED) {
        message.error('connect server closed');
        Socket.queue.push(params);
      }
    } else {
      message.error('connect server could not access');
      Socket.queue.push(params);
    }
  },
};

/**
 * api 请求
 * @param scope
 * @param params
 * @param then
 * @param refresh
 * @constructor
 */
const Ws = {
  CacheKeyLimit: 3000,
  PathLogin: null,
  TipsLogin: 'login timeout',
  Tips403: 'login timeout or not permission',
  cache: (conf) => {
    if (Array.isArray(conf.scope)) {
      Ws.runAll(conf, false);
    } else if (typeof conf.scope === 'string') {
      Ws.run(conf, false);
    } else {
      message.error('scope error');
    }
  },
  real: (conf) => {
    if (Array.isArray(conf.scope)) {
      Ws.runAll(conf, true);
    } else if (typeof conf.scope === 'string') {
      Ws.run(conf, true);
    } else {
      message.error('scope error');
    }
  },
  run: (conf, refresh) => {
    const scope = conf.scope || null;
    const params = conf.params || {};
    const then = conf.then || function () {
    };
    refresh = typeof refresh === 'boolean' ? refresh : false;
    conf.refresh = refresh;
    params.auth_uid = Auth.getUid();
    const apiStack = scope + Parse.jsonEncode(params);
    if (refresh === false && apiStack.length < Ws.CacheKeyLimit && ApiLoad(apiStack) !== null) {
      then(ApiLoad(apiStack));
      return;
    }
    Socket.stackIndex += 1;
    if (Socket.stackIndex > Socket.stackLimit) {
      Socket.stackIndex = 0;
    }
    Socket.stack[Socket.stackIndex] = {};
    Socket.stack[Socket.stackIndex].then = then;
    Socket.stack[Socket.stackIndex].apis = {};
    Socket.stack[Socket.stackIndex].apis[apiStack] = false;
    let r = {client_id: Auth.getClientId(), scope: scope, ...params};
    r.stack = `${Socket.stackIndex}#STACK#${apiStack}`;
    console.log(r);
    r = Parse.jsonEncode(r);
    Socket.send(conf, r);
  },
  runAll: (conf, refresh) => {
    const scope = conf.scope || null;
    const params = conf.params || {};
    const then = conf.then || function () {
    };
    refresh = typeof refresh === 'boolean' ? refresh : false;
    if (Array.isArray(params)) {
      params.forEach((p) => {
        p.auth_uid = Auth.getUid();
      });
    } else {
      params.auth_uid = Auth.getUid();
    }
    let resultQty = 0;
    Socket.stackIndex += 1;
    if (Socket.stackIndex > Socket.stackLimit) {
      Socket.stackIndex = 0;
    }
    Socket.stack[Socket.stackIndex] = {};
    Socket.stack[Socket.stackIndex].then = then;
    Socket.stack[Socket.stackIndex].apis = {};
    //
    scope.forEach((s, idx) => {
      const p = Array.isArray(params) ? params[idx] : params;
      const apiStack = s + Parse.jsonEncode(p);
      if (refresh === false && apiStack.length < Ws.CacheKeyLimit && ApiLoad(apiStack) !== null) {
        Socket.stack[Socket.stackIndex].apis[apiStack] = ApiLoad(apiStack);
        resultQty += 1;
      } else {
        let r = {client_id: Auth.getClientId(), scope: s, ...p};
        Socket.stack[Socket.stackIndex].apis[apiStack] = false;
        r.stack = `${Socket.stackIndex}#STACK#${apiStack}`;
        r = Parse.jsonEncode(r);
        Socket.send(conf, r);
      }
    });
    if (resultQty === scope.length) {
      const res = [];
      Object.entries(Socket.stack[Socket.stackIndex].apis)
        .forEach(([key, value]) => {
          console.log(key);
          res.push(value);
        });
      then(res);
    }
  },
};

export default Ws;