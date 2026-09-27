// Vercel entry point: the whole Express app (server.js) runs as one serverless function.
// vercel.json sends /api/*, /askfacts.js and /validate.js here; everything in public/ is served as static files.
module.exports = require('../server.js');
