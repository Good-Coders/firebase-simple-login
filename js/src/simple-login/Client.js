goog.provide('fb.simplelogin.client');
goog.require('fb.simplelogin.util.env');
goog.require('fb.simplelogin.util.json');
goog.require('fb.simplelogin.util.validation');
goog.require('fb.simplelogin.util.sjcl');

goog.require("fb.simplelogin.Vars");
goog.require("fb.simplelogin.Errors");
goog.require("fb.simplelogin.SessionStore");

goog.require("fb.simplelogin.providers.Persona");
goog.require("fb.simplelogin.providers.Password");

goog.require("fb.simplelogin.transports.JSONP");
goog.require("fb.simplelogin.transports.CordovaInAppBrowser");
goog.require("fb.simplelogin.transports.TriggerIoTab");
goog.require("fb.simplelogin.transports.WinChan");
goog.require("fb.simplelogin.transports.WindowsMetroAuthBroker");

/**
 * @constructor
 */
fb.simplelogin.client = function(ref, callback, context, apiHost) {
  var self = this,
      dataURL = ref.toString(),
      namespace = null;

  // Use a global register of auth. callbacks and user state to support concurrent Firebase Simple Login clients
  var globalNamespace = '_FirebaseSimpleLogin';
  window[globalNamespace] = window[globalNamespace] || {};
  window[globalNamespace]['callbacks'] = window[globalNamespace]['callbacks'] || [];
  window[globalNamespace]['callbacks'].push({
    'cb' : callback,
    'ctx'  : context
  });

  // Parse namespace (subdomain) from Firebase ref
  if (goog.isString(dataURL)) {
    var colonInd = dataURL.indexOf('//');
    if (colonInd >= 0) {
      dataURL = dataURL.substring(colonInd + 2);
    }

    var dotInd = dataURL.indexOf('.');
    if (dotInd >= 0) {
      namespace = dataURL.substring(0, dotInd);
    }
  }

  if (!goog.isString(namespace)) {
    throw new Error("new FirebaseSimpleLogin(): First argument must be a valid Firebase reference (i.e. new Firebase(<firebaseURL>)).");
  }

  if (window.location.protocol === "file:" && !fb.simplelogin.util.env.isPhantomJS() && !fb.simplelogin.util.env.isMobileCordovaInAppBrowser() && console && console.log) {
    var message = 'FirebaseSimpleLogin(): Due to browser security restrictions, ' +
        'loading applications via `file://*` URLs will prevent popup-based authentication ' +
        'providers from working properly. When testing locally, you\'ll need to run a ' + 
        'barebones webserver on your machine rather than loading your test files via ' +
        '`file://*`. The easiest way to run a barebones server on your local machine is to ' + 
        '`cd` to the root directory of your code and run `python -m SimpleHTTPServer`, ' +
        'which will allow you to access your content via `http://127.0.0.1:8000/*`.';
    console.log(message);
  }

  if (apiHost) {
    fb.simplelogin.Vars.setApiHost(apiHost);
  }

  this.mRef = ref;
  this.mNamespace = namespace;
  this.sessionLengthDays = null;

  this.mLoginStateChange = function() {
    var callbacks = window[globalNamespace]['callbacks'] || [];
    var args = Array.prototype.slice.apply(arguments);

    for (var ix = 0; ix < callbacks.length; ix++) {
      // Invoke callback in case of error, initial client instantiation,
      // or change in user authentication state.
      var cb = callbacks[ix];
      var invokeCallback = !!args[0] || typeof cb.user === 'undefined';
      if (!invokeCallback) {
        var oldAuthToken, newAuthToken;
        if (cb.user && cb.user.firebaseAuthToken) {
          oldAuthToken = cb.user.firebaseAuthToken;
        }
        if (args[1] && args[1].firebaseAuthToken) {
          newAuthToken = args[1].firebaseAuthToken;
        }
        invokeCallback = (oldAuthToken || newAuthToken) && (oldAuthToken !== newAuthToken);
      }

      window[globalNamespace]['callbacks'][ix]['user'] = args[1] || null;

      if (invokeCallback) {
        (function(cb, ctx) {
          if (typeof cb === 'function') {
            setTimeout(function() {
              cb.apply(ctx, args);
            }, 0);
          }
        })(cb.cb, cb.ctx);
      }
    }
  };

  this.resumeSession();
}

/**
 * @export
 */
fb.simplelogin.client.prototype.setApiHost = function(apiHost) {
  fb.simplelogin.Vars.setApiHost(apiHost);
}

/**
 * @private
 */
fb.simplelogin.client.prototype.resumeSession = function() {
  var self = this;
  var session, requestId, error;

  // Look for request tokens stored from a previous OAuth authentication attempt, and see
  // if we have a valid session waiting for us on the server.
  try {
    requestId = sessionStorage.getItem('firebaserequestId');
    sessionStorage.removeItem('firebaserequestId');
  } catch (e) {};

  if (requestId) {
    var transport = fb.simplelogin.transports.JSONP;
    if (fb.simplelogin.transports.XHR.isAvailable()) {
      transport = fb.simplelogin.transports.XHR;
    }

    transport.open(fb.simplelogin.Vars.getApiHost() + '/auth/session', {
      'requestId' : requestId,
      'firebase'  : self.mNamespace
    }, function(error, response) {
      if (response && response.token && response.user) {
        self.attemptAuth(response.token, response.user, /* saveSession */ true);
      } else if (error) {
        fb.simplelogin.SessionStore.clear();
        self.mLoginStateChange(error);
      } else {
        fb.simplelogin.SessionStore.clear();
        self.mLoginStateChange(/* error */ null, /* user */ null);
      }
    });
  } else {
    session = fb.simplelogin.SessionStore.get();
    if (session && session.token && session.user) {
      self.attemptAuth(session.token, session.user, /* saveSession */ false);
    } else {
      self.mLoginStateChange(/* error */ null, /* user */ null);
    }
  }
};

/**
 * @private
 */
fb.simplelogin.client.prototype.attemptAuth = function(token, user, saveSession) {
  var self = this;
  this.mRef['auth'](token, function(error, dummy) {
    if (!error) {
      if (saveSession) {
        fb.simplelogin.SessionStore.set({
          token: token,
          user: user,
          sessionKey: user['sessionKey']
        }, self.sessionLengthDays);
      }

      // Pretend to call this so compilation optimizations won't remove it
      if (typeof dummy == 'function') dummy();

      // Remove the sessionKey from the user object before passing to callback
      delete user['sessionKey'];

      // Include the authentication token on the user object
      user['firebaseAuthToken'] = token;

      self.mLoginStateChange(null, user);
    } else {
      // Firebase.auth() failed, usually due to an expired token. Hit logged-out case.
      fb.simplelogin.SessionStore.clear();
      self.mLoginStateChange(null, null);
    }
  }, function(error) {
    // Firebase authentication expired or was cancelled. Hit logged-out case.
    fb.simplelogin.SessionStore.clear();
    self.mLoginStateChange(null, null);
  });
};

/**
 * @export
 */
fb.simplelogin.client.prototype.login = function() {
  fb.simplelogin.util.validation.validateString(methodId, 1, arguments[0], false);
  var self = this,
      options = arguments[1] || {},
      provider = arguments[0].toLowerCase(),
      methodId = 'FirebaseSimpleLogin.login(' + provider + ')';

  // Validate arguments based upon provider, including backwards-compatibility for old method signatures.
  if (provider === 'password') {

    if (!fb.simplelogin.util.validation.isValidEmail(options.email))
      return this.mLoginStateChange(fb.simplelogin.Errors.get('INVALID_EMAIL'));

    if (!fb.simplelogin.util.validation.isValidPassword(options.password))
      return this.mLoginStateChange(fb.simplelogin.Errors.get('INVALID_PASSWORD'));

  } else if (provider === 'facebook' || provider === 'github' || provider === 'google' || provider === 'persona' || provider === 'twitter' || provider === 'anonymous') {
    fb.simplelogin.util.validation.validateArgCount(methodId, 1, 2, arguments.length);
  }

  // Respect global options
  this.sessionLengthDays = (options.rememberMe) ? 30 : null;

  // Attempt to authenticate the user using the specified method.
  switch (provider) {
    case 'anonymous'      : return this.loginAnonymously(options);
    case 'facebook-token' : return this.loginWithFacebookToken(options);
    case 'github'         : return this.loginWithGithub(options);
    case 'google-token'   : return this.loginWithGoogleToken(options);
    case 'password'       : return this.loginWithPassword(options);
    case 'persona'        : return this.loginWithPersona(options);
    case 'twitter-token'  : return this.loginWithTwitterToken(options);
    case 'facebook'       : 
      if (options['access_token']) {
        return this.loginWithFacebookToken(options);
      } else {
        return this.loginWithFacebook(options);
      }
    case 'google'       : 
      if (options['access_token']) {
        return this.loginWithGoogleToken(options);
      } else {
        return this.loginWithGoogle(options);
      }
    case 'twitter'        : 
      if (options['oauth_token'] && options['oauth_token_secret']) {
        return this.loginWithTwitterToken(options);
      } else {
        return this.loginWithTwitter(options);
      }
    
    default:
      throw new Error('FirebaseSimpleLogin.login() failed: unrecognized authentication provider');
  }
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginAnonymously = function(options) {
  var self = this;
  var provider = 'anonymous';

  options.firebase = this.mNamespace;
  fb.simplelogin.transports.JSONP.open(fb.simplelogin.Vars.getApiHost() + '/auth/anonymous', options, function(error, response) {
    if (error || !response['token']) {
      self.mLoginStateChange(fb.simplelogin.Errors.format(error), null);
    }
    else {
      var token = response['token'];
      var user = response['user'];
      self.attemptAuth(token, user, /* saveSession */ true);
    }
  });
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithPassword = function(options) {
  var self = this;
  options.firebase = this.mNamespace;
  fb.simplelogin.providers.Password.login(options, function(error, response) {
    if (error || !response['token']) {
      self.mLoginStateChange(fb.simplelogin.Errors.format(error));
    } else {
      var token = response['token'];
      var user = response['user'];
      self.attemptAuth(token, user, /* saveSession */ true);
    }
  });
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithGithub = function(options) {
  options['height'] = 850;
  options['width'] = 950;
  this.loginViaOAuth('github', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithGoogle = function(options) {
  options['height'] = 650;
  options['width'] = 575;
  this.loginViaOAuth('google', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithFacebook = function(options) {
  options['height'] = 400;
  options['width'] = 535;
  this.loginViaOAuth('facebook', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithTwitter = function(options) {
  this.loginViaOAuth('twitter', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithFacebookToken = function(options) {
  this.loginViaToken('facebook', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithGoogleToken = function(options) {
  this.loginViaToken('google', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithTwitterToken = function(options) {
  this.loginViaToken('twitter', options);
};

/**
 * @private
 */
fb.simplelogin.client.prototype.loginWithPersona = function(options) {
  var provider = 'persona';
  var self = this;

  if (!navigator['id']) {
    throw new Error('FirebaseSimpleLogin.login(persona): Unable to find Persona include.js');
  }

  fb.simplelogin.providers.Persona.login(options, function(assertion) {
    if (assertion === null) {
      callback(fb.simplelogin.Errors.get('UNKNOWN_ERROR'));
    } else {
      fb.simplelogin.transports.JSONP.open(fb.simplelogin.Vars.getApiHost() + '/auth/persona/token', {
        'firebase'  : self.mNamespace,
        'assertion' : assertion
      }, function(err, res) {
        if (err || !res['token'] || !res['user']) {
          self.mLoginStateChange(fb.simplelogin.Errors.format(err), null);
        } else {
          var token = res['token'];
          var user = res['user'];
          self.attemptAuth(token, user, /* saveSession */ true);
        }
      });
    }
  });
};

/**
 * @export
 */
fb.simplelogin.client.prototype.logout = function() {
  fb.simplelogin.SessionStore.clear();
  this.mRef['unauth']();
  this.mLoginStateChange(null, null);
};



/**
 * @private
 */
fb.simplelogin.client.prototype.loginViaToken = function(provider, options, cb) {
  options = options || {};

  var self = this,
      url = fb.simplelogin.Vars.getApiHost() + '/auth/' + provider + '/token?firebase=' + self.mNamespace;

  fb.simplelogin.transports.JSONP.open(url, options,
    function(err, res) {
      if (err || !res['token'] || !res['user']) {
        self.mLoginStateChange(fb.simplelogin.Errors.format(err), null);
      } else {
        var token = res['token'];
        var user = res['user'];
        self.attemptAuth(token, user, /* saveSession */ true);
      }
    });
}

/**
 * @private
 */
fb.simplelogin.client.prototype.loginViaOAuth = function(provider, options, cb) {
  options = options || {};

  var self = this;
  var url = fb.simplelogin.Vars.getApiHost() + '/auth/' + provider + '?firebase=' + this.mNamespace;
  if (options['scope']) url += '&scope=' + options['scope'];
  if (options['debug']) url += '&debug=' + options['debug'];

  var window_features = {
    'menubar'    : 0,
    'location'   : 0,
    'resizable'  : 0,
    'scrollbars' : 1,
    'status'     : 0,
    'dialog'     : 1,
    'width'      : 700,
    'height'     : 375
  };
  if (options['height']) {
    window_features['height'] = options['height'];
    delete options['height'];
  }
  if (options['width']) {
    window_features['width'] = options['width'];
    delete options['width'];
  }

  var environment = (function() {
    if (fb.simplelogin.util.env.isMobileCordovaInAppBrowser()) {
      return 'mobile-phonegap';
    } else if (fb.simplelogin.util.env.isMobileTriggerIoTab()) {
      return 'mobile-triggerio';
    } else if (fb.simplelogin.util.env.isWindowsMetro()) {
      return 'windows-metro';
    } else {
      return 'desktop';
    }
  })();

  var transport;

  if (environment === 'desktop') {
    transport = 'WinChan';
    var window_features_arr = [];
    for (var key in window_features) {
      window_features_arr.push(key + '=' + window_features[key]);
    }
    options.url += '&transport=winchan',
    options.relay_url = fb.simplelogin.Vars.getApiHost() + '/auth/channel',
    options.window_features = window_features_arr.join(',')
  } else if (environment === 'mobile-phonegap') {
    transport = 'CordovaInAppBrowser';
  } else if (environment === 'mobile-triggerio') {
    transport = 'TriggerIoTab';
  } else if (environment === 'windows-metro') {
    transport = 'WindowsMetroAuthBroker';
  }

  /**
   * TODO: Implement robust transport switcher here
   */
  if (options.preferRedirect ||
      fb.simplelogin.util.env.isChromeiOS() ||
      fb.simplelogin.util.env.isWindowsPhone() ||
      fb.simplelogin.util.env.isStandaloneiOS() ||
      fb.simplelogin.util.env.isTwitteriOS() ||
      fb.simplelogin.util.env.isFacebookiOS()) {

    var requestId = goog.string.getRandomString() + goog.string.getRandomString();
    try {
      // TODO: Throw user-visible exception if sessionstorage is not enabled
      sessionStorage.setItem('firebaserequestId', requestId);
    } catch (e) {};

    url += '&requestId=' + requestId + '&fb_redirect_uri=' + encodeURIComponent(window.location.href);
    return window.location = url;
  }


  fb.simplelogin.transports[transport].open(url, options, function(error, res) {
    if (res && res.token && res.user) {
      self.attemptAuth(res.token, res.user, /* saveSession */ true);
    } else {
      var errObj = error || { code: 'UNKNOWN_ERROR', message: 'An unknown error occurred.' };
      if (error === 'unknown closed window') {
        errObj = { code: 'USER_DENIED', message: 'User cancelled the authentication request.' };
      } else if (res && res.error) {
        errObj = res.error;
      }
      self.mLoginStateChange(fb.simplelogin.Errors.format(errObj), null);
    }
  });
};

/**
 * @private
 */
fb.simplelogin.client.prototype.manageFirebaseUsers = function(method, data, cb) {
  data['firebase'] = this.mNamespace;
  fb.simplelogin.providers.Password[method](data, function(error, result) {
    if (error) {
      return cb && cb(fb.simplelogin.Errors.format(error), null);  
    } else {
      return cb && cb(null, result);
    }
  });
};

/**
 * @export
 */
fb.simplelogin.client.prototype.createUser = function(email, password, cb) {
  this.manageFirebaseUsers('createUser', {
    'email'    : email,
    'password' : password
  }, cb);
};

/**
 * @export
 */
fb.simplelogin.client.prototype.changePassword = function(email, oldPassword, newPassword, cb) {
  this.manageFirebaseUsers('changePassword', {
    'email'       : email,
    'oldPassword' : oldPassword,
    'newPassword' : newPassword
  }, function(error) {
    return cb && cb(error);
  });
};

/**
 * @export
 */
fb.simplelogin.client.prototype.removeUser = function(email, password, cb) {
  this.manageFirebaseUsers('removeUser', {
    'email'    : email,
    'password' : password
  }, function(error) {
    return cb && cb(error);
  });
};

/**
 * @export
 */
fb.simplelogin.client.prototype.sendPasswordResetEmail = function(email, cb) {
  this.manageFirebaseUsers('sendPasswordResetEmail', {
    'email'    : email
  }, function(error) {
    return cb && cb(error);
  });
};

/**
 * @export
 */
fb.simplelogin.client.onOpen = function(cb) {
  fb.simplelogin.transports.WinChan.onOpen(cb);
};