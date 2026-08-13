const crypto = require('crypto');

// Прямые вызовы IAuthenticationService через официальный WebAPI (как это делает
// мобильное приложение): запрос кодируется protobuf (input_protobuf_encoded),
// ответ приходит обычным JSON в {response: {...}}.
//
// Это надёжнее, чем полагаться на внутренний транспорт steam-session, который
// молча проглатывает JSON-ответы.
//
// Метод HTTP зависит от типа эндпоинта: bConstMethod-методы (GetAuthSessionInfo,
// GetAuthSessionsForAccount) Steam принимает только как GET, остальные — POST.

const WEBAPI_BASE = 'https://api.steampowered.com';

// методы, которые Steam принимает только через GET (остальные — POST, как в aiosteampy)
const GET_METHODS = ['Authentication_GetAuthSessionsForAccount'];

const API_HEADERS = {
	accept: 'application/json, text/plain, */*',
	'sec-fetch-site': 'cross-site',
	'sec-fetch-mode': 'cors',
	'sec-fetch-dest': 'empty'
};

function eresultError(result, message) {
	const err = new Error(message || `WebAPI error ${result}`);
	err.eresult = result;
	return err;
}

function decodeJwt(jwt) {
	const parts = String(jwt).split('.');
	if (parts.length !== 3) throw new Error('Invalid JWT token');
	const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
	return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function secretAsBuffer(sharedSecret) {
	if (Buffer.isBuffer(sharedSecret)) return sharedSecret;
	if (/^[0-9a-f]{40}$/i.test(sharedSecret)) return Buffer.from(sharedSecret, 'hex');
	return Buffer.from(sharedSecret, 'base64');
}

// ─── Request encoding (protobufjs) ───

function encodeRequest(protoLoader, method, fields) {
	const { request } = protoLoader(method);
	const type = request;
	const message = type.fromObject(fields || {});
	return type.encode(message).finish();
}

function decodeResponse(protoLoader, method, json) {
	// WebAPI returns JSON; numbers for uint64/fixed64 come as strings already.
	return json || {};
}

function webapiLog(...args) {
	// включается через process.env.AURA_DEBUG=1
	if (process.env.AURA_DEBUG) {
		console.error('[steam-auth-webapi]', ...args);
	}
}

async function webapiCall(protoLoader, method, accessToken, fields) {
	const body = encodeRequest(protoLoader, method, fields);
	const b64 = body.length > 0 ? body.toString('base64') : '';
	const apiMethod = method.replace(/^Authentication_/, '');
	const isGet = GET_METHODS.includes(method);
	const baseUrl = `${WEBAPI_BASE}/IAuthenticationService/${apiMethod}/v1/`;

	const url = new URL(baseUrl);
	url.searchParams.set('access_token', accessToken);

	let options = {
		method: isGet ? 'GET' : 'POST',
		headers: { ...API_HEADERS }
	};

	if (isGet) {
		if (b64) url.searchParams.set('input_protobuf_encoded', b64);
	} else {
		const form = [];
		if (b64) form.push(`input_protobuf_encoded=${encodeURIComponent(b64)}`);
		options.headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
		options.body = form.join('&');
	}

	webapiLog(`${apiMethod} ${isGet ? 'GET' : 'POST'} fields=`, fields && Object.fromEntries(
		Object.entries(fields).map(([k, v]) => [k, k === 'signature' ? Buffer.from(v).toString('hex') : v])
	), 'proto_len=', body.length);

	const res = await fetch(url, options);

	const eresult = res.headers.get('x-eresult');
	const errMsg = res.headers.get('x-error_message');
	if (eresult && parseInt(eresult, 10) !== 1) {
		webapiLog(`${apiMethod} -> x-eresult=`, eresult, 'x-error_message=', errMsg);
		const err = eresultError(parseInt(eresult, 10), errMsg);
		err.signature = fields && fields.signature ? Buffer.from(fields.signature).toString('hex') : null;
		err.clientId = fields && fields.client_id;
		err.version = fields && fields.version;
		err.steamId = fields && fields.steamid;
		throw err;
	}
	if (!res.ok && !eresult) {
		throw new Error(`WebAPI http ${res.status}`);
	}
	const json = await res.json().catch(() => ({ response: {} }));
	return decodeResponse(protoLoader, method, json.response);
}

// ─── Public helpers ───

function getProtoLoader() {
	// protobuf definitions bundled inside steam-session
	const load = require('steam-session/dist/protobuf-generated/load').default;
	return function protoLoader(method) {
		const key = `CAuthentication_${method.replace(/^Authentication_/, '')}`;
		return { request: load[`${key}_Request`], response: load[`${key}_Response`] };
	};
}

// Список всех активных auth-сессий (pending logins) для аккаунта.
async function listAuthSessions(accessToken) {
	const loader = getProtoLoader();
	const result = await webapiCall(loader, 'Authentication_GetAuthSessionsForAccount', accessToken, {});
	return result.client_ids || [];
}

// Детали сессии входа по clientId (IP, геолокация, платформа, версия).
async function getAuthSessionInfo(accessToken, clientId) {
	const loader = getProtoLoader();
	const result = await webapiCall(loader, 'Authentication_GetAuthSessionInfo', accessToken, { client_id: clientId });
	return {
		ip: result.ip,
		geoloc: result.geoloc,
		city: result.city,
		state: result.state,
		platformType: result.platform_type,
		deviceFriendlyName: result.device_friendly_name,
		version: result.version,
		loginHistory: result.login_history
	};
}

// Одобрить/отклонить вход. signature = HMAC-SHA256(sharedSecret) над
	// {version:uint16-le, client_id:uint64-le, steamid:uint64-le} — как в LoginApprover.
	async function updateAuthSessionWithMobileConfirmation(accessToken, sharedSecret, { clientId, version, steamId, approve }) {
		const loader = getProtoLoader();
		const backendSteamId = (typeof steamId === 'bigint') ? steamId : BigInt(steamId);

		const signatureData = Buffer.alloc(2 + 8 + 8);
		signatureData.writeUInt16LE(version & 0xFFFF, 0);
		signatureData.writeBigUInt64LE(BigInt(clientId), 2);
		signatureData.writeBigUInt64LE(backendSteamId, 10);
		const signature = crypto.createHmac('sha256', secretAsBuffer(sharedSecret))
			.update(signatureData)
			.digest();

		await webapiCall(loader, 'Authentication_UpdateAuthSessionWithMobileConfirmation', accessToken, {
			version,
			client_id: String(clientId),
			steamid: String(steamId),
			signature,
			confirm: !!approve,
			persistence: 1
		});
		return true;
	}

module.exports = { listAuthSessions, getAuthSessionInfo, updateAuthSessionWithMobileConfirmation, decodeJwt };