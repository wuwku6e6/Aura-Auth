import React, { useEffect, useState } from 'react';
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
	const [version, setVersion] = useState('');
	// update state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'unavailable' | 'error'
	const [upState, setUpState] = useState('idle');
	const [up, setUp] = useState(null); // { version }
	const [progress, setProgress] = useState(0);

	useEffect(() => {
		let cancelled = false;
		api.getVersion().then(v => { if (!cancelled) setVersion(v); });
		const offCheck = api.on('app:updateAvailable', (p) => {
			if (cancelled) return;
			if (p && p.available && p.version) {
				setUp({ version: p.version });
				if (p.downloaded) setUpState('downloaded');
				else setUpState('available');
			} else if (p && p.error) {
				setUpState('error');
			} else {
				setUpState('unavailable');
			}
		});
		const offProg = api.on('app:updateProgress', (p) => { if (!cancelled) setProgress(p.percent || 0); });
		return () => { cancelled = true; offCheck(); offProg(); };
	}, []);

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

	const checkUpdates = async () => {
		setUpState('checking'); setUp(null);
		const r = await api.checkForUpdates();
		if (r && r.version && r.version !== r.current) {
			setUp({ version: r.version }); setUpState('available');
		} else {
			setUpState('unavailable');
		}
	};

	const downloadAndInstall = async () => {
		if (upState === 'available') {
			setUpState('downloading');
			await api.downloadUpdate();
		} else if (upState === 'downloaded') {
			await api.installUpdate();
		}
	};

	const renderUpdate = () => {
		switch (upState) {
			case 'checking':
				return <button className="update-btn update-btn_apply" disabled>{t('Проверка…')}</button>;
			case 'available':
				return (
					<>
						<span className="update-ver">{up && up.version}</span>
						<button className="update-btn update-btn_apply" onClick={downloadAndInstall}>{t('Скачать и установить')}</button>
					</>
				);
			case 'downloading':
				return <button className="update-btn update-btn_apply" disabled>{t('Скачивание…')}{Math.round(progress)}%</button>;
			case 'downloaded':
				return <button className="update-btn update-btn_apply" onClick={downloadAndInstall}>{t('Перезапустить и установить')}</button>;
			case 'unavailable':
				return <span className="update-ver">{t('Обновление не найдено')}</span>;
			case 'error':
				return <span className="update-ver">{t('Ошибка проверки обновлений')}</span>;
			default:
				return (
					<>
						<span className="update-ver">{up && up.version ? 'v' + up.version : ''}</span>
						<button className="update-btn update-btn_apply" onClick={checkUpdates}>{t('Проверить обновления')}</button>
					</>
				);
		}
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

				<div className="settings-field">
					<div className="settings-field-label">{t('Обновление')}</div>
					<div className="settings-update-row">{renderUpdate()}</div>
				</div>

				<div className="settings-field">
					<div className="settings-field-label">{t('Версия')}</div>
					<div className="settings-field-value">{version || '…'}</div>
				</div>
			</div>
			<div className="settings-foot">{version ? `Aura Auth v${version}` : ''}</div>
		</div>
	);
};

export default SettingsWindow;
