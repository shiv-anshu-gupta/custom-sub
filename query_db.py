"""Quick script to view SV Subscriber SQLite data"""
import sqlite3
from datetime import datetime

DB_PATH = r'C:\Users\shiva\AppData\Roaming\com.sv.subscriber\sv_data.db'

db = sqlite3.connect(DB_PATH)
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')

# Show tables
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print(f"Tables: {tables}\n")

# Sessions
print("=" * 90)
print("SESSIONS")
print("=" * 90)
rows = db.execute(
    "SELECT id, start_time_ms, frame_count, stored_frames, sv_id, smp_cnt_max, capture_mode FROM sessions ORDER BY id"
).fetchall()

if rows:
    print(f"{'ID':<5} {'Start Time':<22} {'Frames':<10} {'Stored':<10} {'SvID':<8} {'Max':<6} {'Mode'}")
    print("-" * 90)
    for r in rows:
        t = datetime.fromtimestamp(r[1] / 1000).strftime('%Y-%m-%d %H:%M:%S') if r[1] else 'N/A'
        print(f"{r[0]:<5} {t:<22} {r[2]:<10} {r[3]:<10} {repr(r[4]):<8} {r[5]:<6} {r[6]}")
else:
    print("(no sessions)")

# Frames (first 20)
print()
print("=" * 110)
print("FRAMES (first 20 rows)")
print("=" * 110)
rows = db.execute(
    "SELECT session_id, frame_index, sv_id, smp_cnt, channels_json, errors, analysis_flags "
    "FROM frames ORDER BY id LIMIT 20"
).fetchall()

if rows:
    print(f"{'Sess':<6} {'Index':<8} {'SvID':<8} {'SmpCnt':<8} {'Channels':<45} {'Err':<6} {'Flags'}")
    print("-" * 110)
    for r in rows:
        ch = r[4][:42] + '...' if len(r[4]) > 45 else r[4]
        print(f"{r[0]:<6} {r[1]:<8} {r[2]:<8} {r[3]:<8} {ch:<45} {r[4+1]:<6} {r[5+1]}")
else:
    print("(no frames)")

# Totals
total = db.execute("SELECT COUNT(*) FROM frames").fetchone()[0]
print(f"\nTotal frames in DB: {total}")

db.close()
