const crypto = require('crypto');

class Logger {
	constructor() {
		this.entries = [];
		this.listeners = new Set();
		this.max = 5000; // large buffer so early startup logs (DNS, updates) aren't dropped
	}

	_onChange() {
		for (let cb of this.listeners) cb(this.entries);
	}

	subscribe(cb) {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	log(level, scope, message) {
		const entry = {
			id: crypto.randomBytes(6).toString('hex'),
			ts: new Date().toISOString(),
			level,
			scope,
			message
		};
		this.entries.push(entry);
		if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
		console.log(`[${entry.ts}] [${level}] ${scope}: ${message}`);
		this._onChange();
		return entry;
	}

	info(scope, message) { return this.log('info', scope, message); }
	debug(scope, message) { return this.log('debug', scope, message); }
	warn(scope, message) { return this.log('warn', scope, message); }
	error(scope, message) { return this.log('error', scope, message); }
	success(scope, message) { return this.log('success', scope, message); }
}

let instance = null;

function getLogger() {
	if (!instance) instance = new Logger();
	return instance;
}

module.exports = { getLogger, Logger };