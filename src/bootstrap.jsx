import React, { useEffect, useState } from 'react';
import { I18nProvider } from './i18n.jsx';
import { applyTheme } from './theme.js';

const DEFAULT_SETTINGS = { language: 'ru', theme: 'aura' };

export function withSettings(Component) {
	return function SettingsRoot() {
		const [settings, setSettings] = useState(null);
		useEffect(() => {
			const api = window.aura;
			let alive = true;
			api.getSettings()
				.then(s => {
					if (!alive) return;
					const cfg = { ...DEFAULT_SETTINGS, ...(s || {}) };
					applyTheme(cfg.theme);
					setSettings(cfg);
				})
				.catch(() => {
					if (!alive) return;
					applyTheme('aura');
					setSettings(DEFAULT_SETTINGS);
				});
			const unsub = api.on('settings:changed', s => {
				if (!s) return;
				const cfg = { ...DEFAULT_SETTINGS, ...s };
				applyTheme(cfg.theme);
				setSettings(cfg);
			});
			return () => { alive = false; if (unsub) unsub(); };
		}, []);
		if (!settings) return null;
		return (
			<I18nProvider key={settings.language} initialLang={settings.language}>
				<Component />
			</I18nProvider>
		);
	};
}
