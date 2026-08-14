; ─────────────────────────────────────────────────────────────────────────────
; Custom NSIS include (electron-builder auto-includes build/installer.nsh).
;
; Purpose: preserve the user's `maFiles` folder across upgrades.
;
; By default electron-builder's uninstaller runs `RMDir /r $INSTDIR` which
; wipes the ENTIRE install directory — including the `maFiles` folder that
; holds the user's account secrets (accounts.json + *.maFile). That makes
; every upgrade silently destroy all saved accounts.
;
; We override the removal step with `customRemoveFiles` so it deletes ONLY the
; app's own files and leaves `maFiles` (and the uninstaller itself) intact.
; ─────────────────────────────────────────────────────────────────────────────

!macro customRemoveFiles
  ; Remove the app's own artifacts (regenerated each install).
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\electron"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\*.asar"
  Delete "$INSTDIR\*.pdb"
  Delete "$INSTDIR\aura-auth-startup.log"

  ; Best-effort: remove now-empty app dirs, but NEVER recurse into $INSTDIR
  ; root, so the `maFiles` folder and the uninstaller are preserved.
  RMDir "$INSTDIR\dist"
  RMDir "$INSTDIR\electron"
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR\node_modules"
!macroend
