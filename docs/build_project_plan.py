from reportlab.lib.pagesizes import letter
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
                                PageBreak, Image, KeepTogether, Flowable)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.lib.enums import TA_LEFT, TA_CENTER

OUT = "/tmp/claude-0/-home-claude/88bb49dd-e268-5abd-b554-a07f2c2c931f/scratchpad/pdf/Akea-Platform-Project-Plan.pdf"
LOGO = "/home/claude/akea-platform/web/public/logo.png"

INK = colors.HexColor("#1E2430"); INK2 = colors.HexColor("#4A5262"); INK3 = colors.HexColor("#6B7383")
BRASS = colors.HexColor("#9A7432"); BRASS_SOFT = colors.HexColor("#F6EFE1"); LINE = colors.HexColor("#E4E6EB")
GOOD = colors.HexColor("#1F7A4A"); GOOD_SOFT = colors.HexColor("#E4F4EA"); WARN = colors.HexColor("#9A5B00"); WARN_SOFT = colors.HexColor("#FCF1DC")
INFO = colors.HexColor("#2B5F96"); INFO_SOFT = colors.HexColor("#E5EEF8"); MUTE_SOFT = colors.HexColor("#F1F2F5")

W, H = letter
M = 0.75 * inch
CW = W - 2 * M

ss = {
  "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=20, leading=25, textColor=INK, spaceAfter=6),
  "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13.5, leading=18, textColor=INK, spaceBefore=12, spaceAfter=5),
  "eyebrow": ParagraphStyle("eb", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=BRASS, spaceAfter=3),
  "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=14.5, textColor=INK2, spaceAfter=6),
  "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8.6, leading=12, textColor=INK3),
  "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.8, leading=12, textColor=INK2),
  "cellb": ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=8.8, leading=12, textColor=INK),
  "bullet": ParagraphStyle("bullet", fontName="Helvetica", fontSize=9.6, leading=13.5, textColor=INK2, leftIndent=12, bulletIndent=2, spaceAfter=1),
}
P = lambda t, s="body": Paragraph(t, ss[s])
def bullets(items):
    return [Paragraph(i, ss["bullet"], bulletText="•") for i in items]

STATUS = {"done": ("Done · live", GOOD, GOOD_SOFT), "db": ("Database done · screens next", WARN, WARN_SOFT),
          "applying": ("Database written · applying", WARN, WARN_SOFT), "next": ("Up next", INFO, INFO_SOFT), "later": ("Planned", INK3, MUTE_SOFT)}

class Pill(Flowable):
    def __init__(self, key):
        super().__init__(); self.text, self.fg, self.bg = STATUS[key]
        self.w = 7 + len(self.text) * 4.9 + 7; self.h = 15
    def wrap(self, *a): return self.w, self.h
    def draw(self):
        c = self.canv; c.setFillColor(self.bg); c.roundRect(0, 0, self.w, self.h, 7.5, stroke=0, fill=1)
        c.setFillColor(self.fg); c.setFont("Helvetica-Bold", 8.2); c.drawString(7, 4.3, self.text)

# ---------------- flow charts ----------------
def _arrow(d, x1, y1, x2, y2, col=INK3):
    d.add(Line(x1, y1, x2, y2, strokeColor=col, strokeWidth=1.2))
    import math
    a = math.atan2(y2 - y1, x2 - x1); s = 5
    d.add(Polygon([x2, y2, x2 - s * math.cos(a - .45), y2 - s * math.sin(a - .45), x2 - s * math.cos(a + .45), y2 - s * math.sin(a + .45)],
                  fillColor=col, strokeColor=col, strokeWidth=0))

def _wrap(text, maxch):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) <= maxch: cur = (cur + " " + w).strip()
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def flow(steps, per_row=4, box_h=52, title=None, accent=BRASS):
    """steps: list of (label, kind) kind in 'start','step','check','end'. Snakes across rows."""
    gap = 22; bw = (CW - (per_row - 1) * gap) / per_row
    rows = (len(steps) + per_row - 1) // per_row
    vgap = 26; top = 6
    h = top + rows * box_h + (rows - 1) * vgap + 4
    d = Drawing(CW, h)
    pos = []
    for i, (label, kind) in enumerate(steps):
        r, c = divmod(i, per_row)
        if r % 2 == 1: c = per_row - 1 - c
        x = c * (bw + gap); y = h - top - (r + 1) * box_h - r * vgap
        pos.append((x, y))
        fill = {"start": accent, "end": GOOD, "check": BRASS_SOFT, "step": colors.white}[kind]
        stroke = {"start": accent, "end": GOOD, "check": BRASS, "step": LINE}[kind]
        tc = colors.white if kind in ("start", "end") else INK
        d.add(Rect(x, y, bw, box_h, rx=8, ry=8, fillColor=fill, strokeColor=stroke, strokeWidth=1.1 if kind != "step" else 1))
        if kind == "check":
            d.add(String(x + 7, y + box_h - 11, "CHECK", fontName="Helvetica-Bold", fontSize=6, fillColor=BRASS))
        lines = _wrap(label, int(bw / 4.6))
        lh = 10.2; y0 = y + box_h / 2 + (len(lines) - 1) * lh / 2 - (6 if kind == "check" else 3)
        for j, ln in enumerate(lines):
            d.add(String(x + bw / 2, y0 - j * lh, ln, fontName="Helvetica-Bold" if kind != "step" else "Helvetica",
                         fontSize=8.4, fillColor=tc, textAnchor="middle"))
        d.add(String(x + 6, y + 5, str(i + 1), fontName="Helvetica-Bold", fontSize=6.5,
                     fillColor=colors.white if kind in ("start", "end") else INK3))
    for i in range(len(pos) - 1):
        (x1, y1), (x2, y2) = pos[i], pos[i + 1]
        if abs(y1 - y2) < 1:
            if x2 > x1: _arrow(d, x1 + bw, y1 + box_h / 2, x2, y2 + box_h / 2)
            else: _arrow(d, x1, y1 + box_h / 2, x2 + bw, y2 + box_h / 2)
        else:
            _arrow(d, x1 + bw / 2, y1, x2 + bw / 2, y2 + box_h)
    return d

def chart_block(title, desc, steps, per_row=4):
    return KeepTogether([P(title, "h2"), P(desc, "small"), Spacer(1, 6), flow(steps, per_row), Spacer(1, 6)])

# ---------------- architecture diagram ----------------
def architecture():
    h = 250; d = Drawing(CW, h)
    def box(x, y, w, hh, title, sub, fill=colors.white, stroke=LINE, tc=INK):
        d.add(Rect(x, y, w, hh, rx=9, ry=9, fillColor=fill, strokeColor=stroke, strokeWidth=1.1))
        d.add(String(x + w / 2, y + hh - 17, title, fontName="Helvetica-Bold", fontSize=9.5, fillColor=tc, textAnchor="middle"))
        for j, ln in enumerate(sub):
            d.add(String(x + w / 2, y + hh - 31 - j * 11, ln, fontName="Helvetica", fontSize=7.8, fillColor=INK2, textAnchor="middle"))
    cw = CW
    # users row
    uw = (cw - 3 * 14) / 4
    users = [("Owners & investors", ["Investor portal, K-1s"]), ("Corporate team", ["Finance, HR, compliance"]),
             ("Hotel managers", ["GM, dept heads"]), ("Hotel staff", ["Clock in, schedule"])]
    for i, (t, s) in enumerate(users):
        box(i * (uw + 14), h - 46, uw, 42, t, s, fill=MUTE_SOFT, stroke=LINE)
    # apps row
    aw = (cw - 14) / 2
    box(0, h - 118, aw, 50, "Web portal (React)", ["Hosted on Render · portal.akeahms.com", "Login button on akeahms.com"], fill=colors.white, stroke=BRASS)
    box(aw + 14, h - 118, aw, 50, "Mobile apps (Expo)", ["iPhone and Android", "Clock in/out, schedule, approvals"], fill=colors.white, stroke=BRASS)
    for i in range(4):
        cx = i * (uw + 14) + uw / 2
        tx = aw / 2 if i < 2 else aw + 14 + aw / 2
        _arrow(d, cx, h - 46, tx + (cx - tx) * 0.35, h - 68)
    # backend
    box(0, h - 196, cw, 58, "Supabase  ·  US East (Virginia)", [
        "Postgres database with per-company, per-hotel and per-role security on every row  ·  Sign-in, two-step codes, social sign-in",
        "Private file storage (reports, vault)  ·  Server functions: bank feeds, Ask AI, scheduled renewal alerts"], fill=BRASS_SOFT, stroke=BRASS)
    _arrow(d, aw / 2, h - 118, aw / 2, h - 138); _arrow(d, aw + 14 + aw / 2, h - 118, aw + 14 + aw / 2, h - 138)
    # integrations
    iw = (cw - 4 * 12) / 5
    ints = [("Plaid / Finicity", "bank feeds"), ("Hotel PMS reports", "night audit, email"), ("STR", "market data"), ("Claude AI", "Ask AI"), ("Bank statements", "any format")]
    for i, (t, s) in enumerate(ints):
        x = i * (iw + 12)
        box(x, 2, iw, 38, t, [s], fill=colors.white, stroke=LINE)
        _arrow(d, x + iw / 2, 40, x + iw / 2, h - 196)
    return d

# ---------------- page decoration ----------------
def on_page(c, doc):
    c.saveState()
    if doc.page > 1:
        c.setStrokeColor(LINE); c.setLineWidth(0.6); c.line(M, H - 0.55 * inch, W - M, H - 0.55 * inch)
        c.setFont("Helvetica-Bold", 8); c.setFillColor(BRASS); c.drawString(M, H - 0.47 * inch, "AKEA HOTEL OPERATIONS PLATFORM")
        c.setFont("Helvetica", 8); c.setFillColor(INK3); c.drawRightString(W - M, H - 0.47 * inch, "Project plan · October 2026")
        c.drawRightString(W - M, 0.45 * inch, f"Page {doc.page}")
        c.drawString(M, 0.45 * inch, "Confidential · Akea Hotel Management Services")
    c.restoreState()

def cover(c, doc):
    c.saveState()
    c.setFillColor(colors.HexColor("#FBF7EE")); c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#F1E6CF")); c.rect(0, 0, W, H * 0.34, stroke=0, fill=1)
    c.drawImage(LOGO, M, H - 2.45 * inch, width=2.8 * inch, height=2.8 * inch * 214 / 472, mask="auto")
    c.setFillColor(BRASS); c.setFont("Helvetica-Bold", 10); c.drawString(M, H - 3.35 * inch, "PROJECT PLAN · OCTOBER 2026")
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 32)
    c.drawString(M, H - 3.95 * inch, "Akea Hotel"); c.drawString(M, H - 4.45 * inch, "Operations Platform")
    c.setFont("Helvetica", 13); c.setFillColor(INK2)
    for i, ln in enumerate(["One white-label system for US hotel owners and management companies:",
                            "dashboards, workforce and payroll hours, finance and bank reconciliation,",
                            "compliance, investors, loan packages and construction."]):
        c.drawString(M, H - 5.05 * inch - i * 18, ln)
    c.setFont("Helvetica-Bold", 10); c.setFillColor(INK)
    y = H * 0.34 - 0.75 * inch
    for k, v in [("Live portal", "akea-portal.onrender.com  (moving to portal.akeahms.com)"),
                 ("Technology", "Supabase (US East) · React web on Render · Expo iOS and Android · TypeScript"),
                 ("Status", "Phase 1 live · Phases 2-4 database built · screens in progress")]:
        c.setFont("Helvetica-Bold", 10); c.setFillColor(BRASS); c.drawString(M, y, k.upper())
        c.setFont("Helvetica", 11); c.setFillColor(INK); c.drawString(M + 1.25 * inch, y, v); y -= 24
    c.restoreState()

doc = BaseDocTemplate(OUT, pagesize=letter, leftMargin=M, rightMargin=M, topMargin=0.8 * inch, bottomMargin=0.75 * inch,
                      title="Akea Hotel Operations Platform — Project Plan", author="Akea Hotel Management Services")
frame = Frame(M, 0.7 * inch, CW, H - 1.5 * inch, id="f", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
doc.addPageTemplates([PageTemplate("cover", frames=[frame], onPage=cover), PageTemplate("body", frames=[frame], onPage=on_page)])

from reportlab.platypus import NextPageTemplate
S = [NextPageTemplate("body"), PageBreak()]

def tbl(rows, widths, head=True, zebra=True):
    data = [[Paragraph(str(c), ss["cellb"] if (head and r == 0) or (ci == 0) else ss["cell"]) for ci, c in enumerate(row)] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE),
          ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5), ("LEFTPADDING", (0, 0), (-1, -1), 6)]
    if head: st += [("BACKGROUND", (0, 0), (-1, 0), MUTE_SOFT)]
    t.setStyle(TableStyle(st)); return t

# ---- 1. Summary ----
S += [P("1 · OVERVIEW", "eyebrow"), P("What we are building", "h1"),
      P("Akea is building its own hotel operations platform and will sell it, under each customer's own brand, to hotel owners and "
        "management companies across the United States. It brings the work of several tools into one place: daily hotel reporting "
        "and payments (today Otelier IntelliSight, TruePlan, Rec, DigiAudit and DigiPay), scheduling, time clock and payroll hours "
        "(today Homebase), and the accounting, compliance, investor and lending work that usually lives in spreadsheets and email."),
      P("Goals", "h2")]
S += bullets(["<b>One login, every hotel.</b> Owners see the whole portfolio; managers see only their hotels; staff see only what their job needs.",
              "<b>Real numbers, fast.</b> Night-audit reports, bank statements and invoices in any format are read automatically within seconds.",
              "<b>Money moves safely.</b> Bills and purchases follow approval limits by role; deposits reconcile to the bank automatically.",
              "<b>Nothing expires unnoticed.</b> Permits, insurance and documents raise alerts at 90, 60, 30 and 7 days.",
              "<b>Sell it.</b> Each customer company gets its own name, logo, colours and web address (white-label)."])
S += [P("Portfolio in the system today", "h2"),
      tbl([["Hotel", "Location", "Rooms", "Status"],
           ["Hampton Inn & Suites", "Cleburne, TX", "80", "Operating"], ["Atwell Suites", "Fort Worth, TX", "95", "Operating"],
           ["Hilton Garden Inn", "Fort Worth, TX", "127", "Operating"], ["Fairfield Inn & Suites", "Fort Worth, TX", "104", "Operating"],
           ["La Quinta Inn & Suites", "Bedford, TX", "110", "Operating"], ["Candlewood Suites", "Alliance, TX", "98", "Development · opens Jun 2027"],
           ["Homewood Suites", "Sarasota, FL", "112", "Development · opens Sep 2027"], ["Atwell Suites DFW Airport South", "Irving, TX", "101", "Development · opens Nov 2027"]],
          [2.3 * inch, 1.6 * inch, 0.7 * inch, CW - 4.6 * inch]),
      Spacer(1, 4), P("Sample data, clearly labelled as sample, fills the dashboards until real reports start flowing in.", "small"),
      PageBreak()]

# ---- 2. Architecture ----
S += [P("2 · HOW IT FITS TOGETHER", "eyebrow"), P("Architecture", "h1"),
      P("There is no separate application server to maintain. Supabase provides the database, sign-in, file storage and a few small "
        "server functions; the web portal and mobile apps talk to it directly. Security is enforced inside the database on every row, "
        "so even a mistake in a screen cannot show someone data their role and hotels do not allow."),
      Spacer(1, 8), architecture(), Spacer(1, 12),
      P("Who can see what", "h2"),
      P("Access = <b>role</b> (what someone can do) + <b>hotels</b> (where). Each module has five levels: none, view, edit, approve, admin. "
        "Roles marked * must use two-step sign-in."),
      tbl([["Role", "Main access", "Approval limit"],
           ["Principal / CEO *", "Everything; admin of users and settings", "Unlimited"],
           ["Regional Director *", "Operations admin; approves finance, workforce, purchasing", "$25,000"],
           ["Corporate Controller *", "Finance and compliance admin", "Unlimited"],
           ["AP Clerk *", "Enters bills and vendors", "None"],
           ["HR Director *", "Workforce admin; pay rates", "—"],
           ["Asset Manager *", "View-only across modules", "—"],
           ["General Manager", "Their hotels: operations admin; approves bills, POs, timesheets", "$5,000"],
           ["Department Head", "Schedules and purchase requests for their area", "$1,000"],
           ["Line Staff", "Own schedule and time clock; purchase requests", "None"],
           ["Investor / Owner *", "Investor portal for their hotels only", "—"],
           ["Auditor / Lender *", "Read-only dashboards, finance, compliance", "—"]],
          [1.7 * inch, 3.8 * inch, CW - 5.5 * inch]),
      PageBreak()]

# ---- 3. Phases ----
phases = [
  ("Phase 1", "Foundation", "done", [
    "Company accounts with white-label branding; 11 hotel-industry roles; invitations by email.",
    "Sign-in: email and password (8+ characters), emailed sign-in link, Google / Microsoft / Apple / LinkedIn buttons, two-step codes from an authenticator app.",
    "Dashboards: Portfolio Overview, Hotel Overview (14 measures vs last year or budget), STR Market (index vs competitive set).",
    "Report Inbox with missing-report alerts; Hotels; Company Information with state-specific registrations; Users & Permissions; White-label Settings."]),
  ("Phase 2", "Workforce — replaces Homebase", "db", [
    "Employees by department with private pay rates (visible to approvers only).",
    "Colour-coded schedule by department; open shifts; publish to staff.",
    "Clock in / out from phone, web or a shared tablet with a personal PIN; links to the scheduled shift.",
    "Daily hours, weekly overtime over 40, timesheet approval, payroll export file."]),
  ("Phase 3", "Finance & accounting", "db", [
    "Vendor list with W-9 and 1099 tracking; bill pay with approval limits by role; payment scheduling.",
    "Purchase orders: request, approve, order, receive; receiving creates the bill automatically.",
    "USALI-style chart of accounts, journal entries, P&L vs budget and last year, monthly budgets.",
    "Bank statements in CSV, OFX, QFX, BAI2, Excel or PDF read in seconds; automatic deposit matching (card batches, Amex net of fees, bill payments).",
    "Plaid and Finicity bank feeds for banks that support them."]),
  ("Phase 4", "Compliance & capital", "applying", [
    "Document vault with folders (legal, tax, insurance, permits, HR, floor plans, loan, investor); hotel floor plan uploads.",
    "Permits and insurance policies with renewal alerts at 90 / 60 / 30 / 7 days and on expiry.",
    "Investor portal: dashboard, ownership, distributions, tax documents and K-1s (each investor sees only their own).",
    "One-click bank loan package, downloaded as a ZIP; personal financial statement (PFS), visible only to its owner.",
    "Separate construction tool: budget vs committed vs spent, lender draws, milestones and change orders."]),
  ("Phase 5", "Intelligence & documents", "next", [
    "Automatic reading of night-audit and other reports so real numbers replace sample data.",
    "Ask AI: plain-English questions answered from your own data, within each person's access.",
    "PDF form filler (e.g. bank and SBA forms) and print-ready views of every page."]),
  ("Phase 6", "Mobile apps", "later", [
    "iPhone and Android apps (Expo): clock in / out, my schedule, shift swaps, approvals and alerts."]),
  ("Phase 7", "Launch", "later", [
    "Testing and security review; portal.akeahms.com with the akeahms.com Login button pointing to it.",
    "Supabase Pro plan before real data; website refresh on Wix (paused)."]),
]
S += [P("3 · DELIVERY", "eyebrow"), P("Phases and status", "h1")]
for code, name, st, items in phases:
    block = [Table([[Paragraph(f"<font color='#9A7432'>{code}</font>  {name}", ParagraphStyle("ph", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=INK)), Pill(st)]],
                   colWidths=[CW - 2.0 * inch, 2.0 * inch], style=[("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                                                                    ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]),
             Spacer(1, 3)] + bullets(items) + [Spacer(1, 5)]
    S.append(KeepTogether(block))
S.append(PageBreak())

# ---- 4. Flow charts ----
S += [P("4 · KEY WORKFLOWS", "eyebrow"), P("Flow charts", "h1"),
      P("How the main processes run, start to finish. Gold boxes are where the system checks something before moving on.")]
S.append(chart_block("Daily reporting: night audit to dashboard",
    "Reports arrive by upload or email and become the next morning's numbers.",
    [("Night audit runs at the hotel", "start"), ("Reports uploaded or emailed to the inbox", "step"), ("File type and hotel recognised", "check"),
     ("Numbers read from PDF, Excel, CSV or text", "step"), ("Confidence check; unsure items go to review", "check"),
     ("Daily numbers and expected deposits saved", "step"), ("Missing reports flagged by 9 AM", "check"), ("Dashboards and alerts update", "end")]))
S.append(chart_block("Schedule to payroll",
    "Replaces Homebase: the schedule drives the time clock, and approved hours feed payroll.",
    [("Manager builds the weekly schedule", "start"), ("Schedule published to staff", "step"), ("Staff clock in by phone or tablet PIN", "step"),
     ("Punch linked to the shift; late or early flagged", "check"), ("Clock out; daily hours calculated", "step"),
     ("Weekly overtime over 40 hours", "check"), ("Manager approves timesheets", "check"), ("Payroll hours exported", "end")]))
S.append(PageBreak())
S.append(chart_block("Bill pay with approval limits",
    "Invoices are read automatically; each approver can only approve up to their limit.",
    [("Invoice uploaded or received", "start"), ("Vendor, amount, dates and account read", "step"), ("AP clerk checks and submits", "step"),
     ("Amount within approver's limit?", "check"), ("Approved; posted to the ledger", "step"), ("Payment scheduled from hotel bank account", "step"),
     ("Bank payment matched automatically", "check"), ("Bill marked paid", "end")]))
S.append(chart_block("Bank reconciliation",
    "Works with live bank feeds or with any statement file for banks without feeds.",
    [("Bank feed sync or statement upload", "start"), ("Statement read in seconds; duplicates skipped", "step"),
     ("Each deposit compared to expected card, cash and OTA deposits", "check"), ("Combined card batches and Amex fees handled", "check"),
     ("Withdrawals matched to bills and payroll", "check"), ("Leftovers shown for a one-click decision", "step"), ("Variances posted to the right account", "step"),
     ("Account reconciled", "end")]))
S.append(chart_block("Purchase order",
    "From a department request to a bill ready for payment.",
    [("Department head requests items", "start"), ("Submitted for approval", "step"), ("Within approver's limit?", "check"), ("Ordered from vendor", "step"),
     ("Goods received and checked", "check"), ("Draft bill created automatically", "step"), ("Matched to vendor invoice", "check"), ("Into bill pay", "end")]))
S.append(PageBreak())
S.append(chart_block("Permits and insurance renewals",
    "Nothing lapses: every expiry date is watched every day.",
    [("Permit or policy saved with its document", "start"), ("Daily check of every expiry date", "step"), ("90 / 60 / 30 / 7 days out?", "check"),
     ("Alert to compliance team and GM", "step"), ("Renewal filed; new document uploaded", "step"), ("Dates updated; alerts clear", "end")], per_row=3))
S.append(chart_block("One-click bank loan package",
    "Everything a lender asks for, gathered into one ZIP download.",
    [("Choose hotel and period", "start"), ("Company and ownership details", "step"), ("P&L, budget and STR history", "step"),
     ("Permits, insurance and entity documents", "step"), ("Personal financial statement (PFS)", "check"), ("Download as one ZIP", "end")], per_row=3))
S.append(chart_block("Investor reporting",
    "Investors see only their own hotels, distributions and tax documents.",
    [("Month closes; numbers final", "start"), ("Investor dashboard updates", "step"), ("Distributions recorded", "step"),
     ("K-1s and tax documents uploaded per investor", "check"), ("Investor notified", "step"), ("Investor views and downloads", "end")], per_row=3))
S.append(PageBreak())

# ---- 5. Next steps ----
S += [P("5 · WHAT HAPPENS NEXT", "eyebrow"), P("Action items", "h1"), P("Owner: Akea", "h2"),
      tbl([["#", "Action", "Why"],
           ["1", "Supabase → Authentication → URL Configuration: Site URL https://akea-portal.onrender.com; add redirect URLs for the portal domains", "Confirmation and sign-in emails open the portal (not localhost)"],
           ["2", "Turn on Microsoft and Google sign-in in Supabase (guided, ~10 min each)", "One-click sign-in for the team"],
           ["3", "Give Render's GitHub app access to the akea-platform repository", "Updates go live automatically"],
           ["4", "Add DNS record for portal.akeahms.com in Microsoft 365; point the website Login button to it", "Branded portal address"],
           ["5", "Plaid and/or Finicity account and keys", "Live bank feeds"],
           ["6", "Anthropic API key (Supabase secret)", "Ask AI"],
           ["7", "Apple Developer account ($99/year) and Google Play account ($25 once)", "Publish the mobile apps"],
           ["8", "Upgrade Supabase to Pro before real data", "Backups, no pausing, more capacity"]],
          [0.3 * inch, 3.9 * inch, CW - 4.2 * inch]),
      P("Owner: Claude (build)", "h2")]
S += bullets(["Finish the Phase 4 database and build the screens for Phases 2-4 (workforce, finance, compliance, investors, construction).",
              "Phase 5: report reading, Ask AI, PDF filler and print views.",
              "Phase 6: mobile apps; Phase 7: testing, security review and launch."])
S += [P("Running costs (estimate)", "h2"),
      tbl([["Service", "Today", "At launch"],
           ["Supabase (database, sign-in, files)", "Free", "$25 / month (Pro)"],
           ["Render (web portal hosting)", "Free", "Free – $7 / month"],
           ["Expo / app stores", "—", "$99 / year Apple + $25 once Google"],
           ["Plaid or Finicity bank feeds", "—", "Per connected account (quote from provider)"],
           ["Ask AI (Anthropic API)", "—", "Pay per use; typically a few dollars per user per month"]],
          [2.6 * inch, 1.3 * inch, CW - 3.9 * inch]),
      Spacer(1, 8), P("Prices are estimates from each provider's public plans and may change; confirm before purchase. STR data use is subject to STR's licence terms.", "small")]

doc.build(S)
print("ok", OUT)
