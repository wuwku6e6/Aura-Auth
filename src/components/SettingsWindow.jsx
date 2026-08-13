import React, { useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { THEMES, THEME_LABELS } from '../theme.js';

const LANGUAGES = [
	{ id: 'ru', labelRu: 'Русский', labelEn: 'Russian' },
	{ id: 'en', labelRu: 'Английский', labelEn: 'English' }
];

const SettingsWindow = () => {
	const { t, lang } = useI18n();
	const api = window.aura;
	const [language, setLanguage] = useState(lang);
	const [theme, setTheme] = useState((document.documentElement.getAttribute('data-theme')) || 'aura');

	const langLabel = (l) => (lang === 'en' ? l.labelEn : l.labelRu);
	const themeLabel = (id) => (lang === 'en' ? THEME_LABELS[id].en : THEME_LABELS[id].ru);

	const onLanguage = (id) => {
		setLanguage(id);
		api.setSettings({ language: id });
	};
	const onTheme = (id) => {
		setTheme(id);
		api.setSettings({ theme: id });
	};

	return (
		<div className="settings-win">
			<div className="settings-head">
				<div className="settings-title">{t('Настройки')}</div>
			</div>
			<div className="settings-body">
				<div className="settings-field">
					<div className="settings-field-label">{t('Язык')}</div>
					<div className="settings-options">
						{LANGUAGES.map(l => (
							<button
								key={l.id}
								type="button"
								className={`settings-option ${language === l.id ? 'sel' : ''}`}
								onClick={() => onLanguage(l.id)}
							>{langLabel(l)}</button>
						))}
					</div>
				</div>

				<div className="settings-field">
					<div className="settings-field-label">{t('Тема')}</div>
					<div className="settings-options">
						{THEMES.map(th => (
							<button
								key={th.id}
								type="button"
								className={`settings-option ${theme === th.id ? 'sel' : ''}`}
								onClick={() => onTheme(th.id)}
							>{themeLabel(th.id)}</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
};

export default SettingsWindow;
