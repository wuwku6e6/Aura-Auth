import React, { createContext, useContext, useCallback } from 'react';

// Russian is the source language. The dictionary key IS the Russian string,
// so in 'ru' mode t() simply returns the key (identity). For 'en' mode it
// returns the translation, falling back to the Russian key when missing.
const EN = {
	// --- App / shell ---
	'Aura Auth': 'Aura Auth',
	'Steam Manager': 'Steam Manager',
	'Загрузка…': 'Loading…',
	'Поиск аккаунта…': 'Search account…',
	'Настройки': 'Settings',
	'Входящих предложений: {n}': 'Incoming offers: {n}',
	'Автоподтверждение': 'Auto-confirm',
	'Автоприём': 'Auto-accept',
	'Активных подтверждений: {n}': 'Active confirmations: {n}',
	'Удалить аккаунт': 'Remove account',
	'Удалить аккаунт «{name}»?': 'Remove account "{name}"?',
	'Добавить аккаунт': 'Add account',
	'Нет выбранного аккаунта': 'No account selected',
	'Добавьте аккаунт через maFile и выполните вход': 'Add an account via maFile and log in',
	'Окно предложения аварийно завершило работу.': 'The trade offer window crashed.',
	'Окно контрактов аварийно завершило работу.': 'The contracts window crashed.',
	'Окно настроек аварийно завершило работу.': 'The settings window crashed.',
	'Окно инвентаря аварийно завершило работу.': 'The inventory window crashed.',
	'Окно инвентаря (CS2) аварийно завершило работу.': 'The inventory (CS2) window crashed.',
	'Попробовать снова': 'Try again',
	'Запрос входа в Steam': 'Steam login request',
	'Устройство: ': 'Device: ',
	'Платформа {n}': 'Platform {n}',
	'Веб-браузер': 'Web browser',
	'Мобильное приложение': 'Mobile app',
	'Клиент Steam': 'Steam Client',
	'Аккаунт: ': 'Account: ',
	'Отклонить': 'Decline',
	'Подтвердить': 'Confirm',
	'Не в сети': 'Offline',
	'Требуется пароль для входа': 'Password required to log in',

	// --- AccountCard ---
	'Не играет': 'Not playing',
	'Играет: {games}': 'Playing: {games}',
	'Код входа': 'Login code',
	'Скопировано ✓': 'Copied ✓',
	'Код Steam Guard, обновится через {n}с. Нажмите, чтобы скопировать': 'Steam Guard code, refreshes in {n}s. Click to copy',
	'Проверка…': 'Checking…',
	'Подтвердить вход': 'Confirm login',
	'Выйти': 'Log out',
	'аватар': 'avatar',
	'Открыть профиль Steam ({id})': 'Open Steam profile ({id})',
	'Пароль': 'Password',
	'запомнить пароль (автовход)': 'remember password (auto-login)',
	'Вход…': 'Logging in…',
	'Войти': 'Log in',
	'автоматически подтверждать 2FA-подтверждения': 'automatically confirm 2FA confirmations',
	'принимать входящие трейды без подтверждения': 'accept incoming trades without confirmation',
	'Играть в игры': 'Play games',
	'Добавить {label} ({appid})': 'Add {label} ({appid})',
	'appID через запятую, напр. 730,570,440': 'appID comma-separated, e.g. 730,570,440',
	'Выбрано: {apps}': 'Selected: {apps}',
	'Играть при запуске': 'Play on launch',
	'Запуск…': 'Starting…',
	'Играть': 'Play',
	'Стоп': 'Stop',
	'Контракты CS2': 'CS2 Contracts',
	'Трейды': 'Trades',
	'Подтверждения': 'Confirmations',
	'Принять все': 'Accept all',
	'Загружаю трейды…': 'Loading trades…',
	'Активных трейдов нет': 'No active trades',
	'Входящие': 'Incoming',
	'Исходящие': 'Outgoing',
	'Проверяемся каждые 15 секунд. Подтверждения входа одобряются одной кнопкой «Подтвердить вход».': 'Checked every 15 seconds. Login confirmations are approved with the single "Confirm login" button.',
	'Нет ожидающих подтверждений': 'No pending confirmations',
	'Подтверждение': 'Confirmation',
	'Принять': 'Accept',
	'Пустой трейд': 'Empty trade',
	'Нет ожидающих входов': 'No pending logins',
	'Вход подтверждён': 'Login confirmed',
	'Выберите игры': 'Select games',
	'Не удалось запустить «игру»': 'Failed to start "game"',
	'Ошибка запуска': 'Launch error',
	'Не удалось остановить': 'Failed to stop',
	'Сначала выберите игры для автоигры': 'Select games for auto-play first',
	'Ошибка': 'Error',
	'Не удалось переименовать': 'Failed to rename',

	// --- AddAccountModal ---
	'Перетащите maFile сюда': 'Drop maFile here',
	'или кликните для выбора файла': 'or click to choose a file',
	'Выбрать через окно': 'Choose via dialog',
	'Добавить': 'Add',
	'без shared_secret': 'no shared_secret',
	'ошибка': 'error',

	// --- GuardModal ---
	'Вход: {account}': 'Login: {account}',
	'Steam запросил код Steam Guard. Введите код из приложения Steam:': 'Steam requested a Steam Guard code. Enter the code from the Steam app:',
	'XXXXX': 'XXXXX',
	'Отправить': 'Send',

	// --- LogPanel ---
	'Развернуть журнал': 'Expand log',
	'Свернуть журнал': 'Collapse log',
	'Журнал': 'Log',

	// --- MassSendPanel ---
	'Массовая отправка': 'Mass send',
	'выбрать предметы → отправить аккаунту': 'select items → send to account',
	'Аккаунт-отправитель': 'Sender account',
	'Нет онлайн-аккаунтов': 'No online accounts',
	'Получатель': 'Recipient',
	'Аккаунт из списка': 'Account from list',
	'Сохранённый SteamID': 'Saved SteamID',
	'— выберите —': '— select —',
	'Торговый токен получателя (если не в друзьях)': "Recipient's trade token (if not friends)",
	'Если получатель не в друзьях — Steam отклонит (ошибка 15). Укажите токен из его трейд-ссылки.': "If the recipient is not a friend, Steam will decline (error 15). Provide the token from their trade link.",
	'— сохранённые получатели —': '— saved recipients —',
	'SteamID64 или трейд-ссылка…': 'SteamID64 or trade link…',
	'Ссылка: partner={p} → SteamID {id}': 'Link: partner={p} → SteamID {id}',
	' — это аккаунт «{name}» из списка': ' — this is account "{name}" from the list',
	'Торговый токен (если не друзья)': 'Trade token (if not friends)',
	'Запомнить получателя': 'Remember recipient',
	'Отмена': 'Cancel',
	'Название (например «Друг 1»)': 'Name (e.g. "Friend 1")',
	'Сохранить': 'Save',
	'Инвентарь': 'Inventory',
	'Макс. предметов / трейд': 'Max items / trade',
	'Пауза, мс': 'Pause, ms',
	'Выбрать предметы…': 'Select items…',
	'Выбрано: {n}': 'Selected: {n}',
	'Только трейдовые предметы (фильтр в окне инвентаря)': 'Tradable items only (filter in inventory window)',
	'Отправить ({n})': 'Send ({n})',
	'Отправка… {sent}/{total}': 'Sending… {sent}/{total}',
	'Готово: {n} предметов': 'Done: {n} items',
	'Ошибка: {err}': 'Error: {err}',
	'Введите SteamID получателя': 'Enter recipient SteamID',
	'Введите название получателя': 'Enter recipient name',
	'Получатель «{name}» сохранён': 'Recipient "{name}" saved',
	'Ошибка сохранения': 'Save error',
	'Выберите аккаунт-отправитель': 'Select a sender account',
	'Выберите аккаунт-получатель': 'Select a recipient account',
	'Укажите SteamID получателя или вставьте трейд-ссылку': 'Provide a recipient SteamID or paste a trade link',
	'Выберите предметы в окне инвентаря': 'Select items in the inventory window',
	'Получатель указан без торгового токена. Steam отклонит отправку (ошибка 15), если вы не друзья.\n\nПродолжить?': 'Recipient has no trade token. Steam will decline the send (error 15) unless you are friends.\n\nContinue?',
	'У этого получателя сохранён токен «{token}», а вы ввели «{input}». Если токен неверный, Steam отклонит отправку (ошибка 15).\n\nПродолжить с введённым токеном?': 'This recipient has a saved token "{token}", but you entered "{input}". If the token is wrong, Steam will decline the send (error 15).\n\nContinue with the entered token?',
	'Удалить сохранённого': 'Remove saved recipient',

	// --- AccountCard (play/contacts) ---
	'Ошибка остановки': 'Stop error',
	'Автоприём трейдов': 'Auto-accept trades',
	'Онлайн': 'Online',
	'Играет': 'Playing',
	'Играет: {games}': 'Playing: {games}',

	// --- Trade offer states (mirror steam-account.cjs) ---
	'Не создан': 'Not created',
	'Активен': 'Active',
	'Принят': 'Accepted',
	'Встречное предложение': 'Counter offer',
	'Истёк': 'Expired',
	'Отменён': 'Cancelled',
	'Отклонён': 'Declined',
	'Недействительные предметы': 'Invalid items',
	'Требует подтверждения': 'Requires confirmation',
	'Отменён отправителем': 'Cancelled by sender',
	'В ожидании (эскроу)': 'Pending (escrow)',

	// --- Cs2TradeWindow (misc) ---
	'Обновить': 'Refresh',
	'Выбрано: {n}/10': 'Selected: {n}/10',
	'Убрать': 'Remove',

	// --- AccountCard (misc) ---
	'Не в сети': 'Offline',
	'Не играет': 'Not playing',
	'Ошибка проверки входа': 'Login check error',
	'Переименовать': 'Rename',
	'Выполнить контракты обмена CS2 без запуска игры': 'Perform CS2 exchange contracts without launching the game',
	'нельзя': 'invalid',

	// --- Cs2TradeWindow (contract/recipe tooltip) ---
	'Качество:': 'Quality:',
	'Шанс:': 'Chance:',
	'Коллекция:': 'Collection:',
	'Float:': 'Float:',
	'рецепт {r}': 'recipe {r}',

	// --- InventoryWindow ---
	'Инвентарь app {app} / {ctx}': 'Inventory app {app} / {ctx}',
	'Поиск…': 'Search…',
	'Только трейдовые': 'Tradable only',
	'Выбрать все ({n})': 'Select all ({n})',
	'Загрузка инвентаря…': 'Loading inventory…',
	'Нет предметов': 'No items',
	'трейд-холд {n} дн.': 'trade hold {n} d.',
	'не трейдовый': 'not tradable',
	'Вернуть в приложение': 'Return to app',
	'Не удалось загрузить инвентарь': 'Failed to load inventory',

	// --- Cs2TradeWindow ---
	'CS2 Trade-Up контракты · выберите 10 предметов одной редкости': 'CS2 Trade-Up contracts · choose 10 items of one rarity',
	'Trade-Up контракты': 'Trade-Up contracts',
	'Режим просмотра без запуска игры (GC недоступен) — крафт будет недоступен': 'View mode without launching the game (GC unavailable) — crafting disabled',
	'Не удалось загрузить инвентарь CS2': 'Failed to load CS2 inventory',
	'Ошибка инвентаря: {err}': 'Inventory error: {err}',
	'Не удалось расчитать EV: {err}': 'Failed to calculate EV: {err}',
	'нет данных от сервера': 'no data from server',
	'Нет данных по коллекциям для этих предметов (не найдены в базе Trade-Up или предметы разной редкости)': 'No collection data for these items (not found in Trade-Up database or items of different rarity)',
	'Ошибка расчёта EV: {err}': 'EV calculation error: {err}',
	'Контракт выполнен! Получено: {n} предмет(ов)': 'Contract executed! Received: {n} item(s)',
	'Контракт не выполнен': 'Contract failed',
	'Все': 'All',
	'Рецепт: {r}': 'Recipe: {r}',
	'выбрано {n}/10 — кликни предмет, чтобы добавить, × — чтобы убрать': 'selected {n}/10 — click an item to add, × — to remove',
	'Подключение к серверам CS2 (GC)…': 'Connecting to CS2 servers (GC)…',
	'Нет предметов для контракта': 'No items for a contract',
	'Выбрано: {n}/10. Нужно ещё {m}.': 'Selected: {n}/10. Need {m} more.',
	'Выполняется…': 'In progress…',
	'Выполнить контракт': 'Execute contract',
	'Возможные выходы контракта': 'Possible contract outputs',
	'История контрактов ({n})': 'Contract history ({n})',
	'Пока нет выполненных контрактов': 'No completed contracts yet',
	'Вход: ': 'Input: ',
	'Получил: ': 'Received: ',
	'нельзя': 'unavailable',

	// --- OfferWindow ---
	'Предложение #{offerId}': 'Offer #{offerId}',
	'Ошибка: {msg}': 'Error: {msg}',
	'Предложение не найдено (возможно, уже обработано).': 'Offer not found (possibly already processed).',
	'ищем id={id} (name={name})\nисточник: {source}': 'looking for id={id} (name={name})\nsource: {source}',
	'Сообщение: ': 'Message: ',
	'Партнёр: ': 'Partner: ',
	'Они предлагают': 'They offer',
	'Вы отдаёте': 'You give',
	'— пусто —': '— empty —',
	'Готово': 'Done',
	'Предложение не активно (статус: {label}).': 'Offer is not active (status: {label}).',

	// --- Settings ---
	'Здесь появятся настройки': 'Settings will appear here',
	'Язык': 'Language',
	'Тема': 'Theme',
	'Русский': 'Russian',
	'Английский': 'English'
};

const I18nContext = createContext(null);

function interpolate(str, vars) {
	if (!vars || typeof str !== 'string') return str;
	return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

export function I18nProvider({ children, initialLang }) {
	const lang = initialLang === 'en' ? 'en' : 'ru';
	const t = useCallback((key, vars) => {
		if (key == null) return '';
		if (lang === 'ru') return interpolate(String(key), vars);
		const val = EN[key];
		return interpolate(val != null ? val : String(key), vars);
	}, [lang]);
	return <I18nContext.Provider value={{ lang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
	const ctx = useContext(I18nContext);
	if (!ctx) return { lang: 'ru', t: (k, v) => (k == null ? '' : interpolate(String(k), v)) };
	return ctx;
}

// Mirror of the backend's trade-offer state names (steam-account.cjs).
// Returns the Russian key so it can be passed through t() for localization.
export function tradeOfferStateName(state) {
	const names = {
		1: 'Не создан',
		2: 'Активен',
		3: 'Принят',
		4: 'Встречное предложение',
		5: 'Истёк',
		6: 'Отменён',
		7: 'Отклонён',
		8: 'Недействительные предметы',
		9: 'Требует подтверждения',
		10: 'Отменён отправителем',
		11: 'В ожидании (эскроу)'
	};
	return names[state] || `State ${state}`;
}
