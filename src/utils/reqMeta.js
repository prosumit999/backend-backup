// src/utils/reqMeta.js
// Extracts request metadata consistently across all controllers
'use strict';

const {v4: uuidv4} = require('uuid');

const getReqMeta = (req) => ({
    // FIXED: was req.requestId — that property doesn't exist.
    //        app.js sets req.id via the request-ID middleware.
    //        Using the wrong property meant audit logs always got a
    //        new random UUID instead of the req's actual X-Request-ID.
    requestId: req.id || req.headers['x-request-id'] || uuidv4(),

    ipAddress: req.ip || req.headers['x-forwarded-for'] ?. split(',')[0] ?. trim() || 'unknown',

    userAgent: req.headers['user-agent'] || 'unknown',
    performedBy: req.user ?. _id
});

module.exports = {
    getReqMeta
};
