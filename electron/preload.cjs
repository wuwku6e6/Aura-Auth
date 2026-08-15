const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aura', {
	init: () => ipcRenderer.invoke('app:init'),
	addMaFile: (content, proxy) => ipcRenderer.invoke('account:addMafile', { content, proxy }),
	login: (name, password, savePassword) => ipcRenderer.invoke('account:login', { name, password, savePassword }),
	submitGuard: (name, code) => ipcRenderer.invoke('account:submitGuard', { name, code }),
	getGuardCode: (name) => ipcRenderer.invoke('account:guardCode', name),
	logout: (name) => ipcRenderer.invoke('account:logout', name),
	remove: (name) => ipcRenderer.invoke('account:remove', name),
	rename: (name, label) => ipcRenderer.invoke('account:rename', { name, label }),
	setAutoConfirm: (name, enabled) => ipcRenderer.invoke('account:autoConfirm', { name, enabled }),
	setAutoAccept: (name, enabled) => ipcRenderer.invoke('account:autoAccept', { name, enabled }),
	setAutoPlay: (name, enabled) => ipcRenderer.invoke('account:autoPlay', { name, enabled }),
	setProxy: (name, proxy) => ipcRenderer.invoke('account:setProxy', { name, proxy }),
	testProxy: (proxy) => ipcRenderer.invoke('account:testProxy', proxy),
	startPlay: (name, appIds) => ipcRenderer.invoke('account:play', { name, appIds }),
	stopPlay: (name) => ipcRenderer.invoke('account:stopPlay', name),
	listAccounts: () => ipcRenderer.invoke('account:list'),
	getOffers: (name) => ipcRenderer.invoke('trades:offers', name),
	openOffer: (name, offer) => ipcRenderer.invoke('offer:open', { name, offer }),
	getOffer: (offerId) => ipcRenderer.invoke('offer:get', offerId),
	openSettings: () => ipcRenderer.invoke('settings:open'),
	getSettings: () => ipcRenderer.invoke('settings:get'),
	setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
	acceptOffer: (name, offerId) => ipcRenderer.invoke('trades:accept', { name, offerId }),
	declineOffer: (name, offerId) => ipcRenderer.invoke('trades:decline', { name, offerId }),
	getConfirmations: (name) => ipcRenderer.invoke('confirms:list', name),
	acceptAllConfirmations: (name) => ipcRenderer.invoke('confirms:acceptAll', name),
	respondConfirmation: (name, confId, confKey, accept) => ipcRenderer.invoke('confirms:respond', { name, confId, confKey, accept }),
	listPendingLogins: () => ipcRenderer.invoke('login:list'),
	respondLogin: (name, clientId, version, approve) => ipcRenderer.invoke('login:respond', { name, clientId, version, approve }),
	getInventory: (name, appId, contextId) => ipcRenderer.invoke('inventory:get', { name, appId, contextId }),
	openInventory: (name, appId, contextId) => ipcRenderer.invoke('inventory:open', { name, appId, contextId }),
	selectInventory: (assetIds) => ipcRenderer.invoke('inventory:select', Array.isArray(assetIds) ? assetIds : []),
	getCs2Inventory: (name) => ipcRenderer.invoke('cs2:inventory', name),
	getCs2InventoryWeb: (name) => ipcRenderer.invoke('cs2:inventory-web', name),
	cs2Craft: (name, assetIds) => ipcRenderer.invoke('cs2:craft', { name, assetIds }),
	getCs2Icon: (name, skin) => ipcRenderer.invoke('cs2:icon', { name, skin }),
	getCs2History: (name) => ipcRenderer.invoke('cs2:history', name),
	getCs2Tradeup: (name, inputs) => ipcRenderer.invoke('cs2:tradeup', { name, inputs }),
	openCs2: (name) => ipcRenderer.invoke('cs2:open', name),
	startMassSend: (name, target, opts) => ipcRenderer.invoke('mass:start', { name, target, opts }),
	stopMassSend: (name) => ipcRenderer.invoke('mass:stop', name),
	listRecipients: () => ipcRenderer.invoke('recipients:list'),
	addRecipient: (data) => ipcRenderer.invoke('recipients:add', data),
	updateRecipient: (id, patch) => ipcRenderer.invoke('recipients:update', { id, patch }),
	removeRecipient: (id) => ipcRenderer.invoke('recipients:remove', id),
 	openMaFileDialog: () => ipcRenderer.invoke('dialog:openMafile'),

	checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
	downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
	installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
	getVersion: () => ipcRenderer.invoke('app:getVersion'),
	openExternalLink: (url) => ipcRenderer.invoke('app:openExternalLink', url),

 	on: (channel, cb) => {
 		const valid = ['account:status', 'account:offers', 'account:confirmations', 'guard:request', 'mass:status', 'log:update', 'inventory:selected', 'login:request', 'settings:changed', 'app:updateAvailable', 'app:updateProgress'];
		if (!valid.includes(channel)) return () => {};
		const listener = (event, payload) => cb(payload);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	}
});