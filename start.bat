@echo off
chcp 65001 >nul
title VreKi Spy
cd /d "%~dp0"
node app\launch.js
if errorlevel 1 pause
