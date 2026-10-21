'use strict';

// Vercel function for every /api/<action> route; the logic lives in lib/walki.js.
module.exports = require('../lib/walki').handle;
