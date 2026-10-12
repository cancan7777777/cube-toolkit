@echo off
rem CubeTimer 本机服务器：静态页面 + Supabase 代理（手机经此同步）
rem 固定网址的意义：浏览器按网址隔离存储，配置/成绩/登录都只对同一网址生效
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=C://Program Files\nodejs\node.exe"
start "CubeTimer Server" /min "%NODE%" server.js 8902
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8902/index.html"
