// Нормализация строки прокси к валидному URL, понятному библиотекам
// (socks-proxy-agent, steam-session, request). Поддерживаются форматы:
//   socks5://user:pass@host:port   (каноничный URL)
//   socks5://host:port:user:pass   (формат продавцов прокси)
//   http://user:pass@host:port
//   http://host:port:user:pass
//   host:port                      (=> socks5h://host:port)
//   host:port:user:pass            (=> socks5h://user:pass@host:port)
//
// ВАЖНО: для SOCKS используется суффикс «h» (socks5h / socks4a) — разрешение
// DNS выполняет сам прокси, а не клиент. Иначе в Node ≥ 18 с autoSelectFamily
// клиентский lookup возвращает МАССИВ адресов, и socks-proxy-agent падает с
// «An invalid destination host was provided». Кроме того, это убирает DNS-утечку.
//
// Возвращает null, если прокси пустой, либо кидает Error при невалидном формате.
function normalizeProxy(raw) {
	const p = (raw || '').trim();
	if (!p) return null;

	let scheme = null;
	let rest = p;
	const m = p.match(/^(socks5|socks4|http|https):\/\//i);
	if (m) {
		scheme = m[1].toLowerCase();
		rest = p.slice(m[0].length);
	}

	// Уже в URL-форме (есть @) — оставляем как есть
	if (rest.includes('@')) {
		const url = (scheme ? scheme + '://' : '') + rest;
		new URL(url); // проверка валидности
		return toSocksH(url, scheme);
	}

	const parts = rest.split(':');
	let url;
	if (parts.length >= 4) {
		// формат host:port:user:pass (пароль может содержать ':')
		const host = parts[0];
		const port = parts[1];
		const user = parts[2];
		const pass = parts.slice(3).join(':');
		const u = encodeURIComponent(user);
		const pw = encodeURIComponent(pass);
		url = `${(scheme || 'socks5')}://${u}:${pw}@${host}:${port}`;
	} else {
		url = `${(scheme || 'socks5')}://${rest}`;
	}

	new URL(url); // проверка валидности
	return toSocksH(url, scheme);
}

// Переводит socks5/socks4 в socks5h/socks4a (proxy-side DNS).
function toSocksH(url, scheme) {
	if (scheme === 'http' || scheme === 'https') return url;
	if (!/^socks/i.test(url)) url = 'socks5h://' + url;
	if (scheme === 'socks4') return url.replace(/^socks4a?:/i, 'socks4a:');
	return url.replace(/^socks5?:/i, 'socks5h:');
}

module.exports = { normalizeProxy };

