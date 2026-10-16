#!/bin/bash
# Wait for stock Android to come back, then read the mainline RAM log through it.
# Used when a boot is left to finish unattended (e.g. overnight): no human step after
# pulling the stick. adb connect goes through Terminal.app (macOS denies tmux LAN access).
cd "$(dirname "$0")/../.." || exit 1
# Armed while Android is still up (the usual case: the stick is flashed during the Android
# session), it must first see Android GO AWAY, or it reads the previous boot's log at once.
while ping -c1 -t2 192.168.1.200 >/dev/null 2>&1; do sleep 5; done
echo "Android down at $(date +%T); waiting for it to return"
for i in $(seq 1 360); do
  ping -c1 -t2 192.168.1.200 >/dev/null 2>&1 && break
  sleep 10
done
ping -c1 -t2 192.168.1.200 >/dev/null 2>&1 || { echo "Android never came back (1 h)"; exit 1; }
echo "Android up at $(date +%T); waiting 40 s for adbd"
sleep 40
for i in 1 2 3 4 5; do
  timeout 60 adb connect 192.168.1.200:5555 >/dev/null 2>&1
  adb devices | grep -q "192.168.1.200:5555.device" && break
  sleep 15
done
adb -s 192.168.1.200:5555 root >/dev/null 2>&1; sleep 3
timeout 120 bun run himedia:ramoops
