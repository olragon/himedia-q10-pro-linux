#!/bin/bash
# stick-backup.sh <file-on-stick> [--freeze] — MAC side: copy one file from the Q10's boot stick to
# ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/backups/<YYYYMMDD>-<file>, sha256-verified end to end.
#
#   stick-backup.sh rootfs.img.good
#   stick-backup.sh rootfs.img --freeze     the LIVE root: fsfreeze / for the copy (consistent image)
#
# --freeze: the root filesystem inside rootfs.img is frozen (writers block, nothing is lost) while the
# file is streamed, and thawed right after. A guard thaws it after GUARD seconds whatever happens, so a
# dropped connection can never leave the box frozen. The box-side sha256 is taken from the SAME read
# stream, so "both sides agree" proves the transfer; the freeze is what makes the image consistent.
# Never deletes anything: removing the stick copy is a separate, explicit step.
set -euo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=15"
f=${1:?usage: stick-backup.sh <file-on-stick> [--freeze]}; freeze=${2:-}
case "$f" in */*|..*) echo "⛔ a file name on the stick, not a path"; exit 2 ;; esac
D=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/backups; mkdir -p "$D"
out="$D/$(date +%Y%m%d)-$f"; GUARD=900
[ -e "$out" ] && { echo "⛔ $out exists — refusing to overwrite a backup"; exit 2; }
size=$($SSH $H "stat -c %s /mnt/stick/$f")
echo "[local->remote:${H#*@}] /mnt/stick/$f ($size bytes) -> $out ${freeze:+(root frozen)}"
remote_hash=$(mktemp)
if [ "$freeze" = "--freeze" ]; then
  $SSH $H "set -e; sync; (sleep $GUARD; fsfreeze -u / 2>/dev/null) </dev/null >/dev/null 2>&1 &
    fsfreeze -f /; trap 'fsfreeze -u /' EXIT
    cat /mnt/stick/$f | tee >(sha256sum | cut -d' ' -f1 >&2)" > "$out.part" 2> "$remote_hash"
else
  $SSH $H "cat /mnt/stick/$f | tee >(sha256sum | cut -d' ' -f1 >&2)" > "$out.part" 2> "$remote_hash"
fi
sleep 1   # the remote sha256sum may print after cat closes the stream
rh=$(grep -oE '^[0-9a-f]{64}$' "$remote_hash" | tail -1 || true); rm -f "$remote_hash"
lh=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
got=$(stat -f %z "$out.part")
[ "$got" = "$size" ] || { echo "⛔ size $got != $size — kept as $out.part"; exit 1; }
[ -n "$rh" ] && [ "$rh" = "$lh" ] || { echo "⛔ sha256 box=${rh:-none} mac=$lh — kept as $out.part"; exit 1; }
mv "$out.part" "$out"; echo "$lh  $(basename "$out")" > "$out.sha256"
[ "$freeze" = "--freeze" ] && $SSH $H 'touch /tmp/.thaw-check && rm /tmp/.thaw-check && echo "root writable again"'
echo "OK $out  sha256 $lh"
