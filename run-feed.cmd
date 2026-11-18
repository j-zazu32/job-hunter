@echo off
rem Runs the daily job feed, the local model first pass, and the phone push. Windows Task Scheduler calls this file.
cd /d "%~dp0"
if not exist logs mkdir logs
echo ===== %date% %time% ===== >> logs\feed.log
node fetch-jobs.mjs >> logs\feed.log 2>&1
rem Local model scores the new jobs (resume stays on this server). A failure here must not stop the push.
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0score-local.ps1" >> logs\feed.log 2>&1
rem Phone push: top 5 new jobs, or "No new matches today"
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0notify.ps1" -Daily >> logs\feed.log 2>&1
