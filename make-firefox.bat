@echo off
rem Build the Firefox (Gecko) extension package. Same as: make firefox
rem Usage: make-firefox.bat [--out <dir>] [--unpacked-only]
node "%~dp0tools\build-firefox.cjs" %*
