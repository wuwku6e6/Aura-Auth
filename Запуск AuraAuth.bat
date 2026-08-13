@echo off
chcp 65001 >nul
title AuraAuth
cd /d "%~dp0"
call npm start
pause