// Global color theme switching for SDA (Aura Auth).
// The default theme ("aura") is defined by the :root variables in styles.css.
// Darker variants are applied via [data-theme="..."] attribute on <html>.

export const THEMES = [
	{ id: 'aura', labelRu: 'Aura (сине-фиолетовая)', labelEn: 'Aura (blue-violet)' },
	{ id: 'midnight', labelRu: 'Полночь (тёмная)', labelEn: 'Midnight (dark violet)' },
	{ id: 'ocean', labelRu: 'Океан (бирюзовая)', labelEn: 'Ocean (teal)' }
];

export const THEME_LABELS = THEMES.reduce((m, t) => {
	m[t.id] = { ru: t.labelRu, en: t.labelEn };
	return m;
}, {});

export function applyTheme(theme) {
	if (!theme || theme === 'aura') {
		document.documentElement.removeAttribute('data-theme');
	} else {
		document.documentElement.setAttribute('data-theme', theme);
	}
}
