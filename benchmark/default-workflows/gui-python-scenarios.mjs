// Independent Python product scenarios. These do not replace or relax the
// original Node/npm requirements, whose results remain separately recorded.
const python=process.platform==='win32'?'python':'python3';
const gate=`${python} -m unittest discover -s tests -v`;
const base={
 '.flyt/config.json':JSON.stringify({gates:[gate]}),
 '.gitignore':'.flyt/\n__pycache__/\n*.pyc\n',
 'README.md':`# Fielddesk\nOffline maintenance-ticket library for a small facilities team. Python 3.11+, standard library only. No web server or outgoing messages. Tickets use UTC ISO timestamps and statuses open/closed. Run ${gate}.\n`,
 'fielddesk/__init__.py':'',
 'fielddesk/tickets.py':`def list_tickets(tickets, status=None):
    return [t for t in tickets if status is None or t["status"] == status]

def summarize(tickets):
    return {"count": len(tickets), "closed": sum(t["status"] == "closed" for t in tickets)}
`,
 'fielddesk/service.py':`from .tickets import list_tickets, summarize

def get_tickets(tickets, status=None):
    return {"tickets": list_tickets(tickets, status), "summary": summarize(tickets)}
`,
 'fielddesk/storage.py':`import json
from pathlib import Path

def load_tickets(file):
    return json.loads(Path(file).read_text(encoding="utf-8"))

def save_tickets(file, tickets):
    Path(file).write_text(json.dumps(tickets, ensure_ascii=False) + "\\n", encoding="utf-8")
`,
 'fielddesk/settings.py':`def load_settings(env=None):
    env = {} if env is None else env
    return {"page_size": int(env.get("PAGE_SIZE", 25)), "retention_days": int(env.get("RETENTION_DAYS", 30)), "priority": env.get("DEFAULT_PRIORITY", "normal")}
`,
 'tests/test_tickets.py':`import unittest
from fielddesk.tickets import list_tickets, summarize
from fielddesk.service import get_tickets

class TicketsTest(unittest.TestCase):
    def test_filter_and_summary(self):
        tickets = [{"id": "T1", "status": "open"}, {"id": "T2", "status": "closed"}]
        self.assertEqual(list_tickets(tickets, "closed"), [tickets[1]])
        self.assertEqual(summarize(tickets), {"count": 2, "closed": 1})
        self.assertEqual(get_tickets(tickets, "open")["summary"]["count"], 2)
        self.assertEqual(len(tickets), 2)
`,
 'docs/product.md':'# Fielddesk decisions\nSingle workstation, offline. Library callers own the data-file path. A missing file and corrupt JSON are errors. Existing APIs must remain compatible. UTC dates; priorities low/normal/high. No authentication, notifications, payments or external integrations.\n',
};
const rows=`rows=[{"id":"B","title":"Fan, \\\"east\\\"","status":"closed","created_at":"2026-09-02T10:00:00Z"},{"id":"A","title":"=SUM(A1)","status":"open","created_at":"2026-09-01T10:00:00Z"}]\n`;
const check=body=>`import copy, csv, io, json, tempfile, unittest\nfrom pathlib import Path\n${body}\nprint("Independent acceptance passed")\n`;
const task=(id,workflow,title,prompt,body,files={})=>({id,workflow,title,prompt:`${prompt} Preserve existing public APIs. Add regression tests and a README example. Run ${gate}.`,
 files:{...base,...files},check:check(body),checkLanguage:'python',testCommand:gate,python});
export const GUI_PYTHON_SCENARIOS=[
 task('py-complex-search','deliver-complex-task','Deliver Unicode ticket search and filtered summaries',
 `Use two dependent milestones and run ${gate} for each, then verify integration. Assume well-formed tickets with string title, list-of-string tags and string status. (1) Add search_tickets(tickets, query) in fielddesk/search.py. Split the query on whitespace; match every term as a casefolded substring of the title or any tag, using Unicode casefold (STRASSE must match Straße). Return a new list in original order containing the original matching ticket objects; do not mutate inputs. Empty/whitespace-only query returns a new list of all tickets. Non-string query raises ValueError. (2) Add search_ticket_report(tickets, query, status=None) in service.py: use search_tickets, then filter by exact status when provided, and return {tickets: filtered, summary: {count, closed}} computed only from the returned tickets. Reuse the existing summary helper and keep get_tickets unchanged. Document one integration example and cover Unicode, terms across title/tags, no matches, empty query, status filtering and non-mutation.`,
 `from fielddesk.search import search_tickets\nfrom fielddesk.service import search_ticket_report, get_tickets\nrows=[{"id":"A","title":"Straße fan","tags":["Urgent","HVAC"],"status":"open"},{"id":"B","title":"Street light","tags":["urgent"],"status":"closed"},{"id":"C","title":"Straße lamp","tags":["urgent"],"status":"closed"}]\nbefore=copy.deepcopy(rows)\nfound=search_tickets(rows," STRASSE\\tURGENT ")\nassert found==[rows[0],rows[2]] and found[0] is rows[0]\nassert search_tickets(rows,"fan hvac")==[rows[0]]\nassert search_tickets(rows,"missing")==[]\nall_rows=search_tickets(rows," \\n ")\nassert all_rows==rows and all_rows is not rows\nfor bad in [None,42,[]]:\n    with unittest.TestCase().assertRaises(ValueError): search_tickets(rows,bad)\nassert search_ticket_report(rows,"strasse",status="closed")=={"tickets":[rows[2]],"summary":{"count":1,"closed":1}}\nassert search_ticket_report(rows,"missing")=={"tickets":[],"summary":{"count":0,"closed":0}}\nassert search_ticket_report(rows,"urgent")["summary"]=={"count":3,"closed":2}\nassert get_tickets(rows,"open")["summary"]=={"count":3,"closed":2}\nassert rows==before`),
 task('py-change-csv','make-change','Safe maintenance-ticket CSV',
 'Add export_tickets_csv(tickets) in fielddesk/export.py returning a string with columns id,title,status, CRLF records and a final CRLF, even for an empty list. Escape commas, quotes and embedded newlines. Prefix titles beginning =,+,-,@ with an apostrophe. Preserve input order and do not mutate tickets.',
 `from fielddesk.export import export_tickets_csv\n${rows}before=copy.deepcopy(rows)\nout=export_tickets_csv(rows)\nassert list(csv.reader(io.StringIO(out))) == [["id","title","status"],["B",rows[0]["title"],"closed"],["A","'=SUM(A1)","open"]]\nassert out.endswith("\\r\\n") and out.startswith("id,title,status\\r\\n")\nassert export_tickets_csv([])=="id,title,status\\r\\n"\nfor title in ["+cmd","-1","@ref","a\\nb",'say "hi"']:\n    row={**rows[0],"title":title}\n    actual=list(csv.reader(io.StringIO(export_tickets_csv([row]))))[1][1]\n    assert actual == ("'"+title if title[0] in "=+-@" else title)\nassert rows==before`),
 task('py-change-pagination','make-change','Stable filtered ticket pages',
 'Add paginate_tickets(tickets,page=1,per_page=25,status=None) in tickets.py and get_ticket_page with the same signature in service.py. Return {items,total,page,per_page}. Filter before slicing, sort created_at descending then id ascending for ties, without mutation. Reject booleans, nonintegers, page<1 or per_page outside 1..100 with ValueError. Out-of-range pages have empty items.',
 `from fielddesk.service import get_ticket_page\n${rows}before=copy.deepcopy(rows)\nassert get_ticket_page(rows,2,1)=={"items":[rows[1]],"total":2,"page":2,"per_page":1}\nassert get_ticket_page(rows,status="closed")["total"]==1\nassert get_ticket_page(rows,9)["items"]==[]\nfor args in [(0,1),(1,101),(1.5,1),(True,1)]:\n    with unittest.TestCase().assertRaises(ValueError): get_ticket_page(rows,*args)\nties=[{**rows[0],"id":"Z"},{**rows[0],"id":"A"}]\nassert get_ticket_page(ties)["items"][0]["id"]=="A"\nassert rows==before`),
 task('py-change-settings','make-change','Actionable settings validation',
 'Harden load_settings: PAGE_SIZE is an integer 1..100, RETENTION_DAYS integer 1..365, DEFAULT_PRIORITY low/normal/high. Omitted keys use existing defaults. Trim valid string values and lowercase priority. Empty/whitespace strings, junk, nonintegral numbers and out-of-range values raise ValueError naming the field. Return a fresh object and do not mutate the supplied mapping.',
 `from fielddesk.settings import load_settings\nassert load_settings()=={"page_size":25,"retention_days":30,"priority":"normal"}\nenv={"PAGE_SIZE":" 100 ","RETENTION_DAYS":"1","DEFAULT_PRIORITY":" HIGH "}\nassert load_settings(env)=={"page_size":100,"retention_days":1,"priority":"high"}\nassert env["DEFAULT_PRIORITY"]==" HIGH "\nfor key,val in [("PAGE_SIZE",""),("PAGE_SIZE","1.2"),("PAGE_SIZE","101"),("RETENTION_DAYS","0"),("RETENTION_DAYS","366"),("DEFAULT_PRIORITY","urgent")]:\n    with unittest.TestCase().assertRaisesRegex(ValueError,key): load_settings({key:val})`),
 task('py-bug-median','fix-bug','Correct even-sized resolution medians',
 'median_resolution_minutes in metrics.py overstates the median when an even number of tickets is closed. Reproduce the bug with a failing command before fixing it. For even counts return the arithmetic mean of the two middle sorted durations; odd counts use the middle, empty input returns None. Accept nonnegative numeric durations and leave input order unchanged.',
 `from fielddesk.metrics import median_resolution_minutes as median\nvalues=[40,10,30,20]\nassert median(values)==25 and values==[40,10,30,20]\nassert median([7,1,3])==3\nassert median([]) is None\nassert median([0,1])==0.5`,
 {'fielddesk/metrics.py':`def median_resolution_minutes(durations):
    if not durations:
        return None
    values = sorted(durations)
    return values[len(values) // 2]
`}),
 task('py-bug-date','fix-bug','Include the final UTC reporting day',
 'tickets_in_month in reports.py excludes most of the final day of a month. Reproduce with a failing test command before repairing it. Include UTC timestamps from the first instant of the chosen month up to but excluding the next month. Preserve the function signature and input order. Cover leap day, December rollover and exact boundaries. Inputs are valid canonical UTC ISO timestamps ending Z, integer years 2000..2100 and months 1..12.',
 `from fielddesk.reports import tickets_in_month\nrows=[{"created_at":s} for s in ["2024-02-01T00:00:00Z","2024-02-29T23:59:59Z","2024-03-01T00:00:00Z"]]\nassert tickets_in_month(rows,2024,2)==rows[:2]\nrows=[{"created_at":s} for s in ["2026-12-31T23:59:59Z","2027-01-01T00:00:00Z"]]\nassert tickets_in_month(rows,2026,12)==rows[:1]`,
 {'fielddesk/reports.py':`import calendar
from datetime import datetime, timezone

def tickets_in_month(tickets, year, month):
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year, month, calendar.monthrange(year, month)[1], tzinfo=timezone.utc)
    return [t for t in tickets if start <= datetime.fromisoformat(t["created_at"].replace("Z", "+00:00")) <= end]
`}),
 task('py-bug-cache','fix-bug','Retry a failed asynchronous ticket load',
 'TicketCache.get in cache.py caches failed tasks forever. Reproduce with a failing command before fixing it. After a loader raises, a subsequent get must retry. Concurrent callers share one in-flight load, and successful results remain cached. Preserve exceptions and the async API.',
 `import asyncio\nfrom fielddesk.cache import TicketCache\nasync def verify():\n    calls=0\n    async def loader():\n        nonlocal calls\n        calls+=1\n        await asyncio.sleep(0)\n        if calls==1: raise OSError("temporary")\n        return ["T1"]\n    cache=TicketCache(loader)\n    with unittest.TestCase().assertRaises(OSError): await cache.get()\n    a,b=await asyncio.gather(cache.get(),cache.get())\n    assert a==b==["T1"] and calls==2\n    assert await cache.get()==["T1"] and calls==2\nasyncio.run(verify())`,
 {'fielddesk/cache.py':`import asyncio

class TicketCache:
    def __init__(self, loader):
        self.loader = loader
        self.task = None

    async def get(self):
        if self.task is None:
            self.task = asyncio.create_task(self.loader())
        return await self.task
`}),
 task('py-complex-report','deliver-complex-task','Deliver reporting and CSV across modules',
 `Use two dependent milestones and run ${gate} for each, then verify integration. (1) Add monthly_report(tickets,year,month) in reports.py returning {year,month,count,closed_count}, counting tickets created in that UTC month. Reject boolean/noninteger year/month, years outside 2000..2100, or months outside 1..12 with ValueError. (2) Expose get_monthly_report in service.py and export_monthly_report_csv(report) in export.py, producing header year,month,count,closed_count and one CRLF data row with final CRLF. Cover leap day, December rollover, empty months and open tickets.`,
 `from fielddesk.service import get_monthly_report\nfrom fielddesk.export import export_monthly_report_csv\nrows=[{"status":"closed","created_at":"2024-02-29T23:59:59Z"},{"status":"open","created_at":"2024-02-01T00:00:00Z"},{"status":"closed","created_at":"2024-03-01T00:00:00Z"}]\nr=get_monthly_report(rows,2024,2)\nassert r=={"year":2024,"month":2,"count":2,"closed_count":1}\nassert export_monthly_report_csv(r)=="year,month,count,closed_count\\r\\n2024,2,2,1\\r\\n"\nassert get_monthly_report([],2026,12)["count"]==0\nfor y,m in [(1999,1),(2026,13),(True,1),(2026,1.5)]:\n    with unittest.TestCase().assertRaises(ValueError): get_monthly_report([],y,m)`),
 task('py-complex-migration','deliver-complex-task','Migrate ticket storage without losing data',
 `Use two dependent milestones and run ${gate} for each, then verify integration. (1) Add normalize_store(value) in schema.py: legacy list becomes {version:2,tickets:list}; a version-2 dictionary validates and retains tickets. Return a fresh envelope without mutating input. Reject unsupported versions, booleans as version, or non-list tickets with ValueError. (2) Integrate storage: load_tickets returns the tickets list from either format; save_tickets writes the version-2 envelope with a final newline. Corrupt JSON and unsupported data must raise, never silently reset.`,
 `from fielddesk.schema import normalize_store\nfrom fielddesk.storage import load_tickets, save_tickets\n${rows}assert normalize_store(rows)=={"version":2,"tickets":rows}\nenvelope={"version":2,"tickets":rows}\nassert normalize_store(envelope)==envelope and normalize_store(envelope) is not envelope\nfor bad in [None,{"version":3,"tickets":[]},{"version":2,"tickets":{}},{"version":True,"tickets":[]}]:\n    with unittest.TestCase().assertRaises(ValueError): normalize_store(bad)\nwith tempfile.TemporaryDirectory() as directory:\n    file=Path(directory)/"tickets.json"\n    file.write_text(json.dumps(rows),encoding="utf-8")\n    assert load_tickets(file)==rows\n    save_tickets(file,rows)\n    raw=file.read_text(encoding="utf-8")\n    assert raw.endswith("\\n") and json.loads(raw)==envelope\n    assert load_tickets(file)==rows\n    file.write_text('{"version":3,"tickets":[]}',encoding="utf-8")\n    with unittest.TestCase().assertRaises(ValueError): load_tickets(file)`),
 task('py-complex-validation','deliver-complex-task','Validate and create maintenance tickets',
 `Use two dependent milestones and run ${gate} for each, then verify integration. (1) Add validate_ticket(ticket) in validation.py returning {valid:bool,errors:list[str]}; require nonblank string id/title, status open/closed, priority low/normal/high, tags as a list of nonblank strings. Malformed input including None must return errors naming fields without crashing, coercion or mutation. (2) Add create_ticket(existing,ticket) in service.py: validate and reject invalid or duplicate id with ValueError; return a new list with the ticket appended, preserving existing.`,
 `from fielddesk.validation import validate_ticket\nfrom fielddesk.service import create_ticket\ngood={"id":"T1","title":"Fix fan","status":"open","priority":"normal","tags":["HVAC"]}\nassert validate_ticket(good)=={"valid":True,"errors":[]}\nfor bad in [None,{},dict(good,title=" "),dict(good,tags=[None]),dict(good,priority="urgent"),dict(good,tags="HVAC")]:\n    r=validate_ticket(bad)\n    assert r["valid"] is False and r["errors"] and all(isinstance(e,str) for e in r["errors"])\n    with unittest.TestCase().assertRaises(ValueError): create_ticket([],bad)\nold=[]\nassert create_ticket(old,good)==[good] and old==[]\nwith unittest.TestCase().assertRaises(ValueError): create_ticket([good],good)`),
];
