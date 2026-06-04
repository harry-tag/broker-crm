@echo off
cd /d C:\Users\HarrisonWaddell\broker-crm
node scripts\weekly-digest.js >> scripts\digest-log.txt 2>&1
