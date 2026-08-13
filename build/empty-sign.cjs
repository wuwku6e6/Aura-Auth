// No-op code-signing hook for electron-builder.
// We don't have a code-signing certificate, so signing is skipped entirely.
// This prevents electron-builder from downloading/extracting the winCodeSign
// toolchain (which fails on Windows when it tries to create symlinks).
exports.default = async (configuration) => {
	return configuration.path;
};
