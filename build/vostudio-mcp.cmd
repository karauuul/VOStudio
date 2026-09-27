@echo off
set ELECTRON_RUN_AS_NODE=1
"%~dp0VO Studio.exe" "%~dp0resources\app.asar.unpacked\out\main\bridge.js" %*
