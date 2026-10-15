import React, { useMemo, useState } from "react";
import { db } from "../lib/sb";
import { Ctx, addDays, todayIn, fmtDate, wallToUtc, inTz, fmtClock, weekStart, DOW, hoursBetween, hrs, usd } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, HotelSelect, Notice, SampleBadge, downloadFile, toCsv, Seg } from "../ui";

type Dept = { id: string; name: string; color: string; sort: number };
type Emp = {
  id: string; hotel_id: string; user_id: string | null; first_name: string; last_name: string; email: string | null; phone: string | null;
  department_id: string | null; position: string | null; employment_type: string; status: string; hire_date: string | null; has_pin: boolean; data_source: string;
};
type Shift = { id: string; hotel_id: string; employee_id: string | null; department_id: string | null; position: string | null; starts_at: string; ends_at: string; break_minutes: number; notes: string | null; published: boolean; data_source: string };
type Pay = { employee_id: string; pay_type: "hourly" | "salary"; rate: number; ot_eligible: boolean };

const EMP_COLS = "id,hotel_id,user_id,first_name,last_name,email,phone,department_id,position,employment_type,status,hire_date,has_pin,data_source";
const name = (e?: Emp | null) => (e ? `${e.first_name} ${e.last_name}` : "Open shift");
const tint = (hex: string, a = 0.12) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
function useHotel(ctx: Ctx) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(() => {
    try { return localStorage.getItem("akea.wf.hotel") || operating[0]?.id || ""; } catch { return operating[0]?.id || ""; }
  });
  const set = (v: string) => { setHotelId(v); try { localStorage.setItem("akea.wf.hotel", v); } catch { /* ignore */ } };
  const hotel = ctx.hotels.find((h) => h.id === hotelId) || operating[0];
  return { operating, hotel, hotelId: hotel?.id || "", setHotelId: set };
}

// ======================= Schedule =======================
export function Schedule({ ctx }: { ctx: Ctx }) {
  const { operating, hotel, hotelId, setHotelId } = useHotel(ctx);
  const tz = hotel?.timezone || "America/Chicago";
  const canEdit = ctx.can("workforce", "edit");
  const [week, setWeek] = useState(() => weekStart(todayIn(tz)));
  const [deptFilter, setDeptFilter] = useState<string>("");
  const [edit, setEdit] = useState<Partial<Shift> & { date?: string; start?: string; end?: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));

  const q = useAsync(async () => {
    if (!hotelId) return null;
    const from = wallToUtc(week, "00:00", tz), to = wallToUtc(addDays(week, 7), "00:00", tz);
    const [depts, emps, shifts, pay] = await Promise.all([
      db.get<Dept>(`departments?select=id,name,color,sort&tenant_id=eq.${ctx.tenant.id}&order=sort.asc`),
      db.get<Emp>(`employees?select=${EMP_COLS}&hotel_id=eq.${hotelId}&status=eq.active&order=last_name.asc`),
      db.get<Shift>(`shifts?select=*&hotel_id=eq.${hotelId}&starts_at=gte.${from}&starts_at=lt.${to}&order=starts_at.asc`),
      ctx.can("workforce", "approve") ? db.get<Pay>(`employee_pay?select=employee_id,pay_type,rate,ot_eligible&hotel_id=eq.${hotelId}`) : Promise.resolve([] as Pay[]),
    ]);
    return { depts, emps, shifts, pay };
  }, [hotelId, week]);

  const data = q.data;
  const deptOf = (id: string | null) => data?.depts.find((d) => d.id === id);
  const grid = useMemo(() => {
    if (!data) return null;
    const byEmpDay = new Map<string, Shift[]>();
    data.shifts.forEach((s) => {
      const k = `${s.employee_id || "open"}|${inTz(s.starts_at, tz).date}`;
      byEmpDay.set(k, [...(byEmpDay.get(k) || []), s]);
    });
    const groups = data.depts
      .filter((d) => !deptFilter || d.id === deptFilter)
      .map((d) => ({ dept: d, emps: data.emps.filter((e) => e.department_id === d.id) }))
      .filter((g) => g.emps.length);
    const payOf = new Map<string, Pay>(data.pay.map((p: Pay) => [p.employee_id, p] as [string, Pay]));
    const dayHours = days.map((day) => data.shifts.filter((s) => inTz(s.starts_at, tz).date === day && (!deptFilter || s.department_id === deptFilter))
      .reduce((a, s) => a + hoursBetween(s.starts_at, s.ends_at, s.break_minutes), 0));
    const dayCost = days.map((day) => data.shifts.filter((s) => inTz(s.starts_at, tz).date === day && s.employee_id && (!deptFilter || s.department_id === deptFilter))
      .reduce((a, s) => { const p = payOf.get(s.employee_id!); return a + (p?.pay_type === "hourly" ? hoursBetween(s.starts_at, s.ends_at, s.break_minutes) * p.rate : 0); }, 0));
    const empHours = (id: string) => data.shifts.filter((s) => s.employee_id === id).reduce((a, s) => a + hoursBetween(s.starts_at, s.ends_at, s.break_minutes), 0);
    return { byEmpDay, groups, dayHours, dayCost, empHours, hasPay: data.pay.length > 0 };
  }, [data, deptFilter, week]);

  const unpublished = data?.shifts.filter((s) => !s.published).length || 0;
  async function publish() {
    setMsg(null);
    try {
      const from = wallToUtc(week, "00:00", tz), to = wallToUtc(addDays(week, 7), "00:00", tz);
      const r = await db.update("shifts", `hotel_id=eq.${hotelId}&starts_at=gte.${from}&starts_at=lt.${to}&published=eq.false`, { published: true }, "id");
      setMsg({ kind: "good", text: `${r.length} shift${r.length === 1 ? "" : "s"} published. Staff can now see this week.` });
      q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function copyLastWeek() {
    setMsg(null);
    try {
      const from = wallToUtc(addDays(week, -7), "00:00", tz), to = wallToUtc(week, "00:00", tz);
      const prev = await db.get<Shift>(`shifts?select=*&hotel_id=eq.${hotelId}&starts_at=gte.${from}&starts_at=lt.${to}`);
      if (!prev.length) { setMsg({ kind: "bad", text: "Last week has no shifts to copy." }); return; }
      const rows = prev.map((s) => {
        const a = inTz(s.starts_at, tz), b = inTz(s.ends_at, tz);
        return { tenant_id: ctx.tenant.id, hotel_id: hotelId, employee_id: s.employee_id, department_id: s.department_id, position: s.position,
          starts_at: wallToUtc(addDays(a.date, 7), a.time, tz), ends_at: wallToUtc(addDays(b.date, 7), b.time, tz), break_minutes: s.break_minutes, notes: s.notes, published: false };
      });
      await db.insert("shifts", rows, "id");
      setMsg({ kind: "good", text: `Copied ${rows.length} shifts from last week as drafts. Review, then publish.` });
      q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  function openNew(empId: string | null, date: string) {
    const e = data?.emps.find((x) => x.id === empId);
    setEdit({ employee_id: empId, department_id: e?.department_id || deptFilter || data?.depts[0]?.id || null, position: e?.position || "", date, start: "07:00", end: "15:00", break_minutes: 30, published: false, notes: "" });
  }
  function openEdit(s: Shift) {
    const a = inTz(s.starts_at, tz), b = inTz(s.ends_at, tz);
    setEdit({ ...s, date: a.date, start: a.time, end: b.time });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    try {
      const startIso = wallToUtc(edit.date!, edit.start!, tz);
      let endIso = wallToUtc(edit.date!, edit.end!, tz);
      if (Date.parse(endIso) <= Date.parse(startIso)) endIso = wallToUtc(addDays(edit.date!, 1), edit.end!, tz); // overnight shift
      const row = { employee_id: edit.employee_id || null, department_id: edit.department_id || null, position: edit.position || null,
        starts_at: startIso, ends_at: endIso, break_minutes: Number(edit.break_minutes || 0), notes: edit.notes || null, published: !!edit.published };
      if (edit.id) await db.update("shifts", `id=eq.${edit.id}`, row, "id");
      else await db.insert("shifts", { ...row, tenant_id: ctx.tenant.id, hotel_id: hotelId }, "id");
      setEdit(null);
      q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  async function remove() {
    if (!edit?.id) return;
    try { await db.remove("shifts", `id=eq.${edit.id}`); setEdit(null); q.reload(); } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }

  const today = todayIn(tz);
  const chip = (s: Shift) => {
    const d = deptOf(s.department_id);
    const c = d?.color || "#64748B";
    return (
      <button key={s.id} type="button" className={"shift" + (s.published ? "" : " draft")} onClick={() => canEdit && openEdit(s)} disabled={!canEdit}
        style={{ background: tint(c, 0.13), borderColor: c, color: "var(--fg)" }}
        title={`${name(data?.emps.find((x) => x.id === s.employee_id))} · ${d?.name || ""} · ${s.position || ""}${s.published ? "" : " · draft"}`}>
        <span className="t">{fmtClock(s.starts_at, tz)}–{fmtClock(s.ends_at, tz)}</span>
        {s.position && <span className="p">{s.position}</span>}
      </button>
    );
  };

  return (
    <>
      <PageHead eyebrow="Workforce" title="Schedule" desc="Plan the week by department. Drafts are dashed until you publish them to staff."
        actions={canEdit && data ? (<>
          <button className="btn" onClick={copyLastWeek}>Copy last week</button>
          <button className="btn pri" onClick={publish} disabled={!unpublished}>{unpublished ? `Publish ${unpublished} draft${unpublished === 1 ? "" : "s"}` : "All published"}</button>
        </>) : null} />
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} />
        <div className="seg" role="group" aria-label="Week">
          <button type="button" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
          <button type="button" className="on" onClick={() => setWeek(weekStart(today))}>{fmtDate(week).replace(/, \d{4}$/, "")} – {fmtDate(addDays(week, 6))}</button>
          <button type="button" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
        </div>
        <span className="grow" />
        {data && <SampleBadge show={data.shifts.some((s) => s.data_source === "sample")} />}
      </div>
      {data && (
        <div className="dept-chips" role="group" aria-label="Filter by department">
          <button type="button" className={!deptFilter ? "on" : ""} onClick={() => setDeptFilter("")}>All departments</button>
          {data.depts.filter((d) => data.emps.some((e) => e.department_id === d.id)).map((d) => (
            <button type="button" key={d.id} className={deptFilter === d.id ? "on" : ""} onClick={() => setDeptFilter(deptFilter === d.id ? "" : d.id)}
              style={deptFilter === d.id ? { background: d.color, borderColor: d.color, color: "#fff" } : { borderColor: tint(d.color, 0.5) }}>
              <i className="dot" style={{ background: deptFilter === d.id ? "#fff" : d.color }} />{d.name}
            </button>
          ))}
        </div>
      )}
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {data && grid && (
        <section className="card sched-card">
          <div className="sched" style={{ gridTemplateColumns: `minmax(170px, 1.3fr) repeat(7, minmax(104px, 1fr))` }}>
            <div className="sh corner">Team</div>
            {days.map((d, i) => (
              <div key={d} className={"sh" + (d === today ? " today" : "")}>
                <b>{DOW[i]}</b> <span>{Number(d.slice(8))}</span>
                <div className="tag">{hrs(grid.dayHours[i])}{grid.hasPay ? ` · ${usd(grid.dayCost[i])}` : ""}</div>
              </div>
            ))}
            {/* open shifts */}
            <div className="sn open"><b>Open shifts</b><span className="tag">Unassigned</span></div>
            {days.map((d) => (
              <div key={"o" + d} className={"sc" + (d === today ? " today" : "")} onDoubleClick={() => canEdit && openNew(null, d)}>
                {(grid.byEmpDay.get(`open|${d}`) || []).filter((s) => !deptFilter || s.department_id === deptFilter).map(chip)}
                {canEdit && <button type="button" className="add" onClick={() => openNew(null, d)} aria-label={`Add open shift ${d}`}>+</button>}
              </div>
            ))}
            {grid.groups.map((g) => (
              <React.Fragment key={g.dept.id}>
                <div className="sg" style={{ gridColumn: "1 / -1", borderLeftColor: g.dept.color, background: tint(g.dept.color, 0.06) }}>
                  <i className="dot" style={{ background: g.dept.color }} />{g.dept.name}<span className="tag"> · {g.emps.length}</span>
                </div>
                {g.emps.map((e) => (
                  <React.Fragment key={e.id}>
                    <div className="sn">
                      <span className="av" style={{ background: tint(g.dept.color, 0.18), color: g.dept.color }}>{e.first_name[0]}{e.last_name[0]}</span>
                      <span style={{ minWidth: 0 }}><b>{name(e)}</b><span className="tag">{e.position} · {hrs(grid.empHours(e.id))}</span></span>
                    </div>
                    {days.map((d) => (
                      <div key={e.id + d} className={"sc" + (d === today ? " today" : "")}>
                        {(grid.byEmpDay.get(`${e.id}|${d}`) || []).map(chip)}
                        {canEdit && <button type="button" className="add" onClick={() => openNew(e.id, d)} aria-label={`Add shift for ${name(e)} on ${d}`}>+</button>}
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ))}
          </div>
          {!grid.groups.length && <Empty title="No team members yet.">Add people on the Team page, then schedule them here.</Empty>}
        </section>
      )}
      {edit && data && (
        <Modal title={edit.id ? "Edit shift" : "Add shift"} onClose={() => setEdit(null)} onSubmit={save}
          footer={<>{edit.id && <button type="button" className="btn" onClick={remove} style={{ marginRight: "auto", color: "var(--bad)" }}>Delete shift</button>}
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save shift</button></>}>
          <div className="fgrid">
            <Field label="Team member" id="sEmp">
              <select id="sEmp" value={edit.employee_id || ""} onChange={(e) => {
                const emp = data.emps.find((x) => x.id === e.target.value);
                setEdit({ ...edit, employee_id: e.target.value || null, department_id: emp?.department_id || edit.department_id, position: emp?.position || edit.position });
              }}>
                <option value="">Open shift (anyone can pick up)</option>
                {data.emps.map((x) => <option key={x.id} value={x.id}>{name(x)} · {x.position}</option>)}
              </select>
            </Field>
            <Field label="Department" id="sDept">
              <select id="sDept" value={edit.department_id || ""} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}>
                {data.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Position" id="sPos"><input id="sPos" value={edit.position || ""} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></Field>
            <Field label="Date" id="sDate"><input id="sDate" type="date" required value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
            <Field label="Start" id="sStart"><input id="sStart" type="time" required value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} /></Field>
            <Field label="End" id="sEnd" hint="Earlier than start = ends next day"><input id="sEnd" type="time" required value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} /></Field>
            <Field label="Unpaid break (minutes)" id="sBreak"><input id="sBreak" type="number" min={0} max={120} value={edit.break_minutes ?? 0} onChange={(e) => setEdit({ ...edit, break_minutes: Number(e.target.value) })} /></Field>
            <Field label="Notes" id="sNotes" span><input id="sNotes" value={edit.notes || ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
          <label className="check-row" htmlFor="sPub" style={{ marginTop: 12 }}><input id="sPub" type="checkbox" checked={!!edit.published} onChange={(e) => setEdit({ ...edit, published: e.target.checked })} /> Published (visible to staff)</label>
        </Modal>
      )}
    </>
  );
}

// ======================= Time clock =======================
export function TimeClock({ ctx }: { ctx: Ctx }) {
  const { operating, hotel, hotelId, setHotelId } = useHotel(ctx);
  const tz = hotel?.timezone || "America/Chicago";
  const isManager = ctx.can("workforce", "edit");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = useAsync(() => db.rpc<any>("clock", { p_action: "status" }).catch((e) => ({ error: e.message })), []);
  const q = useAsync(async () => {
    if (!isManager || !hotelId) return null;
    const dayStart = wallToUtc(todayIn(tz), "00:00", tz);
    const [punches, emps, depts, shifts] = await Promise.all([
      db.get<any>(`time_punches?select=id,employee_id,clock_in,clock_out,source,shift_id&hotel_id=eq.${hotelId}&or=(clock_out.is.null,clock_in.gte.${dayStart})&order=clock_in.desc`),
      db.get<Emp>(`employees?select=${EMP_COLS}&hotel_id=eq.${hotelId}&status=eq.active`),
      db.get<Dept>(`departments?select=id,name,color,sort&tenant_id=eq.${ctx.tenant.id}`),
      db.get<Shift>(`shifts?select=*&hotel_id=eq.${hotelId}&starts_at=gte.${dayStart}&starts_at=lt.${wallToUtc(addDays(todayIn(tz), 1), "00:00", tz)}`),
    ]);
    return { punches, emps, depts, shifts };
  }, [hotelId]);

  async function act(action: "in" | "out", opts: { pin?: string; employee?: string } = {}) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await db.rpc<any>("clock", { p_action: action, p_hotel: opts.pin ? hotelId : null, p_pin: opts.pin || null, p_employee: opts.employee || null });
      setMsg({ kind: "good", text: action === "in" ? `${r.employee} clocked in at ${fmtClock(r.clock_in, tz)}.` : `${r.employee} clocked out. ${hrs(r.minutes / 60)} on this punch.` });
      setPin("");
      q.reload();
      mine.reload();
    } catch (e: any) {
      setMsg({ kind: "bad", text: e.message });
      setPin("");
    } finally { setBusy(false); }
  }
  const empOf = (id: string) => q.data?.emps.find((e) => e.id === id);
  const deptOf = (id: string | null) => q.data?.depts.find((d) => d.id === id);
  const onNow = q.data?.punches.filter((p: any) => !p.clock_out) || [];
  const late = q.data ? q.data.shifts.filter((s) => s.employee_id && Date.parse(s.starts_at) < Date.now() - 10 * 60000 && Date.parse(s.ends_at) > Date.now()
    && !q.data!.punches.some((p: any) => p.employee_id === s.employee_id)) : [];
  const my = mine.data;

  return (
    <>
      <PageHead eyebrow="Workforce" title="Time Clock" desc="Staff clock in and out here, on the shared front-desk tablet with their PIN, or in the mobile app." />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <div className="grid g2">
        <Card title="My time clock">
          {mine.loading && !my ? <Loading /> : my?.error ? (
            <p className="small muted" style={{ margin: 0 }}>{my.error}. Your manager can link your sign-in to your employee profile on the Team page.</p>
          ) : my ? (
            <div className="stack">
              <div><b style={{ fontSize: 18 }}>{my.employee}</b><div className="small muted">{my.clocked_in ? `Clocked in since ${fmtClock(my.clock_in, tz)} · ${hrs(my.minutes / 60)} so far` : my.clock_out ? `Last clocked out ${fmtClock(my.clock_out, tz)}` : "Not clocked in"}</div></div>
              {my.clocked_in ? <button className="btn pri wide" disabled={busy} onClick={() => act("out")}>Clock out</button>
                : <button className="btn pri wide" disabled={busy} onClick={() => act("in")}>Clock in</button>}
            </div>
          ) : null}
        </Card>
        {isManager && (
          <Card title="Shared time clock (PIN)" actions={<HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} id="tcHotel" />}>
            <div className="pinpad">
              <input aria-label="Employee PIN" className="code-input" inputMode="numeric" type="password" autoComplete="off" maxLength={6} value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" />
              <div className="keys">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => (
                  <button key={k} type="button" className="btn" onClick={() => setPin(k === "C" ? "" : k === "⌫" ? pin.slice(0, -1) : (pin + k).slice(0, 6))}>{k}</button>
                ))}
              </div>
              <div className="acts" style={{ justifyContent: "stretch" }}>
                <button className="btn pri" style={{ flex: 1 }} disabled={busy || pin.length < 4} onClick={() => act("in", { pin })}>Clock in</button>
                <button className="btn" style={{ flex: 1 }} disabled={busy || pin.length < 4} onClick={() => act("out", { pin })}>Clock out</button>
              </div>
              <p className="small muted" style={{ margin: 0 }}>Leave this page open on the front-desk tablet. Each person uses their own 4–6 digit PIN, set on the Team page.</p>
            </div>
          </Card>
        )}
      </div>
      {isManager && (
        <>
          <div className="sp" />
          {q.loading && !q.data && <Loading />}
          {q.error && <ErrorBox error={q.error} retry={q.reload} />}
          {q.data && (
            <div className="grid g2">
              <Card title={`On the clock now · ${onNow.length}`} flush>
                {onNow.length ? (
                  <div className="list">{onNow.map((p: any) => {
                    const e = empOf(p.employee_id); const d = deptOf(e?.department_id || null);
                    return (
                      <div className="li" key={p.id} style={{ alignItems: "center" }}>
                        <span className="stripe" style={{ background: d?.color || "var(--line)" }} />
                        <div style={{ minWidth: 0 }}><div className="t">{name(e)}</div><div className="s">{d?.name} · in at {fmtClock(p.clock_in, tz)} · {hrs((Date.now() - Date.parse(p.clock_in)) / 3.6e6)} · {p.source}</div></div>
                        <div className="r"><button className="btn sm" disabled={busy} onClick={() => act("out", { employee: p.employee_id })}>Clock out</button></div>
                      </div>
                    );
                  })}</div>
                ) : <Empty title="Nobody is clocked in right now." />}
              </Card>
              <Card title="Needs attention" flush>
                {late.length ? (
                  <div className="list">{late.map((s) => {
                    const e = empOf(s.employee_id!);
                    return (
                      <div className="li" key={s.id} style={{ alignItems: "center" }}>
                        <span className="stripe" style={{ background: "var(--warn)" }} />
                        <div><div className="t">{name(e)} hasn't clocked in</div><div className="s">Scheduled {fmtClock(s.starts_at, tz)}–{fmtClock(s.ends_at, tz)} · {s.position}</div></div>
                        <div className="r"><button className="btn sm" disabled={busy} onClick={() => act("in", { employee: s.employee_id! })}>Clock in for them</button></div>
                      </div>
                    );
                  })}</div>
                ) : <Empty title="Everyone scheduled so far has clocked in." />}
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ======================= Timesheets & payroll =======================
type PayRow = { employee_id: string; employee: string; hotel_id: string; department: string | null; dept_color: string | null; pay_type: string | null; rate: number | null;
  days: Record<string, number> | null; total_hours: number; regular_hours: number; overtime_hours: number; est_gross: number | null; open_punches: number; unapproved: number };

export function Timesheets({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState("");
  const today = todayIn();
  const [period, setPeriod] = useState<"this" | "last" | "two">("last");
  const ws = weekStart(today);
  const range: [string, string] = period === "this" ? [ws, addDays(ws, 6)] : period === "last" ? [addDays(ws, -7), addDays(ws, -1)] : [addDays(ws, -14), addDays(ws, -1)];
  const canApprove = ctx.can("workforce", "approve");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [detail, setDetail] = useState<PayRow | null>(null);
  const q = useAsync(() => db.rpc<PayRow[]>("payroll_hours", { p_from: range[0], p_to: range[1], p_hotels: hotelId ? [hotelId] : null }), [hotelId, range[0], range[1]]);
  const days: string[] = [];
  for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) days.push(d);
  const rows = q.data || [];
  const tot = rows.reduce((a, r) => ({ h: a.h + Number(r.total_hours), r: a.r + Number(r.regular_hours), o: a.o + Number(r.overtime_hours), g: a.g + Number(r.est_gross || 0), u: a.u + r.unapproved, open: a.open + r.open_punches }), { h: 0, r: 0, o: 0, g: 0, u: 0, open: 0 });
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";

  async function approveAll() {
    setMsg(null);
    try {
      const ids: string[] = [];
      for (const h of hotelId ? [hotelId] : operating.map((x) => x.id)) {
        const tz = ctx.hotels.find((x) => x.id === h)?.timezone || "America/Chicago";
        const ps = await db.get<any>(`time_punches?select=id&hotel_id=eq.${h}&approved_at=is.null&clock_out=not.is.null&clock_in=gte.${wallToUtc(range[0], "00:00", tz)}&clock_in=lt.${wallToUtc(addDays(range[1], 1), "00:00", tz)}`);
        ids.push(...ps.map((p: any) => p.id));
      }
      const n = ids.length ? await db.rpc<number>("approve_punches", { p_ids: ids }) : 0;
      setMsg({ kind: "good", text: `${n} punch${n === 1 ? "" : "es"} approved.` });
      q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  function exportCsv() {
    const head = ["Employee", "Hotel", "Department", "Pay type", "Rate", ...days, "Regular hours", "Overtime hours", "Total hours", "Estimated gross"];
    const body = rows.map((r) => [r.employee, hName(r.hotel_id), r.department, r.pay_type, r.rate, ...days.map((d) => r.days?.[d] ?? 0), r.regular_hours, r.overtime_hours, r.total_hours, r.est_gross]);
    downloadFile(`payroll-hours_${range[0]}_to_${range[1]}.csv`, toCsv([head, ...body]));
  }

  return (
    <>
      <PageHead eyebrow="Workforce" title="Timesheets & Payroll Hours" desc="Daily hours from the time clock, overtime past 40 hours a week, approval and payroll export."
        actions={<>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export for payroll</button>
          {canApprove && <button className="btn pri" onClick={approveAll} disabled={!tot.u}>Approve {tot.u || ""} punches</button>}
        </>} />
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} all />
        <Seg label="Pay period" value={period} onChange={setPeriod} options={[["this", "This week"], ["last", "Last week"], ["two", "Last 2 weeks"]]} />
        <span className="small muted">{fmtDate(range[0])} – {fmtDate(range[1])}</span>
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <div className="stat-row">
        <div className="kpi"><span className="l">Total hours</span><span className="v">{tot.h.toFixed(1)}</span></div>
        <div className="kpi"><span className="l">Regular</span><span className="v">{tot.r.toFixed(1)}</span></div>
        <div className="kpi"><span className="l">Overtime</span><span className="v" style={{ color: tot.o ? "var(--warn)" : undefined }}>{tot.o.toFixed(1)}</span></div>
        {canApprove && <div className="kpi"><span className="l">Estimated gross</span><span className="v">{usd(tot.g)}</span></div>}
        <div className="kpi"><span className="l">Waiting for approval</span><span className="v">{tot.u}</span></div>
        <div className="kpi"><span className="l">Still clocked in</span><span className="v">{tot.open}</span></div>
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          {rows.length ? (
            <div className="tw"><table>
              <thead><tr><th>Employee</th>{!hotelId && <th>Hotel</th>}{days.length <= 7 && days.map((d, i) => <th key={d} className="n">{DOW[i % 7]} {Number(d.slice(8))}</th>)}
                <th className="n">Regular</th><th className="n">OT</th><th className="n">Total</th>{canApprove && <th className="n">Est. gross</th>}<th>Status</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.employee_id} onClick={() => setDetail(r)} style={{ cursor: "pointer" }}>
                  <td className="nowrap"><i className="dot" style={{ background: r.dept_color || "var(--line)" }} /><b>{r.employee}</b><div className="tag">{r.department}</div></td>
                  {!hotelId && <td className="small">{hName(r.hotel_id)}</td>}
                  {days.length <= 7 && days.map((d) => <td key={d} className="n">{r.days?.[d] ? Number(r.days[d]).toFixed(2) : <span className="muted">—</span>}</td>)}
                  <td className="n">{Number(r.regular_hours).toFixed(2)}</td>
                  <td className="n" style={{ color: Number(r.overtime_hours) ? "var(--warn)" : undefined, fontWeight: Number(r.overtime_hours) ? 700 : 400 }}>{Number(r.overtime_hours).toFixed(2)}</td>
                  <td className="n"><b>{Number(r.total_hours).toFixed(2)}</b></td>
                  {canApprove && <td className="n">{r.est_gross != null ? usd(Number(r.est_gross), 2) : "—"}</td>}
                  <td>{r.open_punches ? <Pill kind="info">Clocked in</Pill> : r.unapproved ? <Pill kind="warn">{r.unapproved} to approve</Pill> : <Pill kind="good">Approved</Pill>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No hours recorded for this period." />}
        </Card>
      )}
      {detail && <PunchDetail ctx={ctx} row={detail} range={range} onClose={() => { setDetail(null); q.reload(); }} />}
    </>
  );
}

function PunchDetail({ ctx, row, range, onClose }: { ctx: Ctx; row: PayRow; range: [string, string]; onClose: () => void }) {
  const hotel = ctx.hotels.find((h) => h.id === row.hotel_id);
  const tz = hotel?.timezone || "America/Chicago";
  const canEdit = ctx.can("workforce", "edit");
  const q = useAsync(() => db.get<any>(`time_punches?select=*&employee_id=eq.${row.employee_id}&clock_in=gte.${wallToUtc(range[0], "00:00", tz)}&clock_in=lt.${wallToUtc(addDays(range[1], 1), "00:00", tz)}&order=clock_in.asc`), [row.employee_id]);
  const [edit, setEdit] = useState<any | null>(null);
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    try {
      if (!edit.reason?.trim()) throw new Error("Add a reason for the change — it's kept with the punch.");
      const inIso = wallToUtc(edit.inDate, edit.inTime, tz);
      let outIso = edit.outTime ? wallToUtc(edit.inDate, edit.outTime, tz) : null;
      if (outIso && Date.parse(outIso) <= Date.parse(inIso)) outIso = wallToUtc(addDays(edit.inDate, 1), edit.outTime, tz);
      await db.update("time_punches", `id=eq.${edit.id}`, { clock_in: inIso, clock_out: outIso, break_minutes: Number(edit.break_minutes || 0), edited_reason: edit.reason, approved_at: null, approved_by: null }, "id");
      setEdit(null);
      q.reload();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`${row.employee} · punches`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {q.loading && <Loading />}
      {q.data && (
        <div className="tw"><table>
          <thead><tr><th>Date</th><th>In</th><th>Out</th><th className="n">Break</th><th className="n">Hours</th><th>Source</th><th>Status</th><th></th></tr></thead>
          <tbody>{q.data.map((p: any) => (
            <tr key={p.id}>
              <td className="nowrap">{fmtDate(inTz(p.clock_in, tz).date)}</td>
              <td>{fmtClock(p.clock_in, tz)}</td>
              <td>{p.clock_out ? fmtClock(p.clock_out, tz) : <Pill kind="info">open</Pill>}</td>
              <td className="n">{p.break_minutes}m</td>
              <td className="n">{p.clock_out ? hoursBetween(p.clock_in, p.clock_out, p.break_minutes).toFixed(2) : "—"}</td>
              <td className="small">{p.source}{p.edited_reason && <div className="tag" title={p.edited_reason}>edited</div>}</td>
              <td>{p.approved_at ? <Pill kind="good">Approved</Pill> : <Pill kind="mute">Pending</Pill>}</td>
              <td>{canEdit && <button className="btn sm" onClick={() => { const a = inTz(p.clock_in, tz); setEdit({ ...p, inDate: a.date, inTime: a.time, outTime: p.clock_out ? inTz(p.clock_out, tz).time : "", reason: "" }); }}>Fix</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="fgrid">
            <Field label="Date" id="pD"><input id="pD" type="date" value={edit.inDate} onChange={(e) => setEdit({ ...edit, inDate: e.target.value })} /></Field>
            <Field label="Clock in" id="pI"><input id="pI" type="time" value={edit.inTime} onChange={(e) => setEdit({ ...edit, inTime: e.target.value })} /></Field>
            <Field label="Clock out" id="pO"><input id="pO" type="time" value={edit.outTime} onChange={(e) => setEdit({ ...edit, outTime: e.target.value })} /></Field>
            <Field label="Break (min)" id="pB"><input id="pB" type="number" min={0} value={edit.break_minutes} onChange={(e) => setEdit({ ...edit, break_minutes: e.target.value })} /></Field>
            <Field label="Reason for change" id="pR" span><input id="pR" required value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="e.g. Forgot to clock out; left at 3:05 pm per GM" /></Field>
          </div>
          {err && <Notice kind="bad">{err}</Notice>}
          <div className="acts" style={{ marginTop: 12, justifyContent: "flex-end" }}><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri" onClick={save}>Save punch</button></div>
        </div>
      )}
    </Modal>
  );
}

// ======================= Team =======================
export function Team({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const canEdit = ctx.can("workforce", "edit");
  const canPay = ctx.can("workforce", "approve");
  const [show, setShow] = useState<"active" | "all">("active");
  const [edit, setEdit] = useState<(Partial<Emp> & { pay?: Partial<Pay>; pin?: string; login_email?: string }) | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const q = useAsync(async () => {
    const [emps, depts, pay] = await Promise.all([
      db.get<Emp>(`employees?select=${EMP_COLS}&hotel_id=eq.${hotelId}${show === "active" ? "&status=eq.active" : ""}&order=last_name.asc`),
      db.get<Dept>(`departments?select=id,name,color,sort&tenant_id=eq.${ctx.tenant.id}&order=sort.asc`),
      canPay ? db.get<Pay>(`employee_pay?select=employee_id,pay_type,rate,ot_eligible&hotel_id=eq.${hotelId}`) : Promise.resolve([] as Pay[]),
    ]);
    return { emps, depts, pay };
  }, [hotelId, show]);
  const deptOf = (id: string | null) => q.data?.depts.find((d) => d.id === id);
  const payOf = (id: string) => q.data?.pay.find((p) => p.employee_id === id);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setMsg(null);
    try {
      const row = { first_name: edit.first_name, last_name: edit.last_name, email: edit.email || null, phone: edit.phone || null, department_id: edit.department_id || null,
        position: edit.position || null, employment_type: edit.employment_type || "full_time", status: edit.status || "active", hire_date: edit.hire_date || null };
      let id = edit.id;
      if (id) await db.update("employees", `id=eq.${id}`, row, "id");
      else id = (await db.insert<{ id: string }>("employees", { ...row, tenant_id: ctx.tenant.id, hotel_id: hotelId }, "id"))[0].id;
      if (canPay && edit.pay && edit.pay.rate != null && String(edit.pay.rate) !== "") {
        await db.upsert("employee_pay", { employee_id: id, tenant_id: ctx.tenant.id, hotel_id: hotelId, pay_type: edit.pay.pay_type || "hourly", rate: Number(edit.pay.rate), ot_eligible: edit.pay.pay_type !== "salary", updated_at: new Date().toISOString() }, "employee_id", "employee_id");
      }
      if (edit.pin) await db.rpc("set_employee_pin", { p_employee: id, p_pin: edit.pin });
      if (edit.login_email) {
        const prof = await db.get<any>(`profiles?select=user_id&email=eq.${encodeURIComponent(edit.login_email.trim().toLowerCase())}`);
        if (!prof.length) throw new Error(`Saved, but no portal account uses ${edit.login_email}. Invite them on Users & Permissions first.`);
        await db.update("employees", `id=eq.${id}`, { user_id: prof[0].user_id }, "id");
      }
      setEdit(null);
      setMsg({ kind: "good", text: `${row.first_name} ${row.last_name} saved.` });
      q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }

  const list = q.data?.emps || [];
  return (
    <>
      <PageHead eyebrow="Workforce" title="Team" desc="Everyone who works at each hotel: department, position, pay and time-clock PIN."
        actions={canEdit ? <button className="btn pri" onClick={() => setEdit({ first_name: "", last_name: "", employment_type: "full_time", status: "active", department_id: q.data?.depts[0]?.id, pay: { pay_type: "hourly" } })}>Add team member</button> : null} />
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} />
        <Seg label="Show" value={show} onChange={setShow} options={[["active", "Active"], ["all", "Everyone"]]} />
        <span className="grow" />
        <span className="small muted">{list.length} people</span>
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          {list.length ? (
            <div className="tw"><table>
              <thead><tr><th>Name</th><th>Department</th><th>Position</th><th>Type</th>{canPay && <th className="n">Pay</th>}<th>Hired</th><th>Portal login</th><th>PIN</th><th></th></tr></thead>
              <tbody>{list.map((e) => {
                const d = deptOf(e.department_id); const p = payOf(e.id);
                return (
                  <tr key={e.id}>
                    <td className="nowrap"><b>{name(e)}</b> <SampleBadge show={e.data_source === "sample"} />{e.status !== "active" && <div className="tag">{e.status}</div>}</td>
                    <td className="nowrap"><i className="dot" style={{ background: d?.color || "var(--line)" }} />{d?.name || "—"}</td>
                    <td>{e.position || "—"}</td>
                    <td className="small">{e.employment_type.replace("_", " ")}</td>
                    {canPay && <td className="n">{p ? (p.pay_type === "hourly" ? `${usd(p.rate, 2)}/h` : `${usd(p.rate)}/yr`) : "—"}</td>}
                    <td className="small nowrap">{e.hire_date ? fmtDate(e.hire_date) : "—"}</td>
                    <td>{e.user_id ? <Pill kind="good">Linked</Pill> : <Pill kind="mute">Not linked</Pill>}</td>
                    <td>{e.has_pin ? <Pill kind="good">Set</Pill> : <Pill kind="warn">Not set</Pill>}</td>
                    <td>{canEdit && <button className="btn sm" onClick={() => setEdit({ ...e, pay: p ? { ...p } : { pay_type: "hourly" } })}>Edit</button>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          ) : <Empty title="No team members at this hotel yet." />}
        </Card>
      )}
      {edit && q.data && (
        <Modal title={edit.id ? `Edit ${name(edit as Emp)}` : "Add team member"} onClose={() => setEdit(null)} onSubmit={save} wide
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save</button></>}>
          <div className="fgrid">
            <Field label="First name" id="eF"><input id="eF" required value={edit.first_name || ""} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} /></Field>
            <Field label="Last name" id="eL"><input id="eL" required value={edit.last_name || ""} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} /></Field>
            <Field label="Department" id="eD">
              <select id="eD" value={edit.department_id || ""} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}>
                {q.data.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Position" id="eP"><input id="eP" value={edit.position || ""} onChange={(e) => setEdit({ ...edit, position: e.target.value })} placeholder="e.g. Front Desk Agent" /></Field>
            <Field label="Employment type" id="eT">
              <select id="eT" value={edit.employment_type} onChange={(e) => setEdit({ ...edit, employment_type: e.target.value })}>
                <option value="full_time">Full time</option><option value="part_time">Part time</option><option value="seasonal">Seasonal</option><option value="contract">Contract</option>
              </select>
            </Field>
            <Field label="Status" id="eS">
              <select id="eS" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                <option value="active">Active</option><option value="inactive">Inactive</option><option value="terminated">Terminated</option>
              </select>
            </Field>
            <Field label="Hire date" id="eH"><input id="eH" type="date" value={edit.hire_date || ""} onChange={(e) => setEdit({ ...edit, hire_date: e.target.value })} /></Field>
            <Field label="Mobile phone" id="eM"><input id="eM" type="tel" value={edit.phone || ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Email" id="eE"><input id="eE" type="email" value={edit.email || ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          </div>
          {canPay && (
            <>
              <h4 style={{ margin: "18px 0 8px" }}>Pay <span className="tag">visible to approvers only</span></h4>
              <div className="fgrid">
                <Field label="Pay type" id="ePT">
                  <select id="ePT" value={edit.pay?.pay_type || "hourly"} onChange={(e) => setEdit({ ...edit, pay: { ...edit.pay, pay_type: e.target.value as any } })}>
                    <option value="hourly">Hourly</option><option value="salary">Salary</option>
                  </select>
                </Field>
                <Field label={edit.pay?.pay_type === "salary" ? "Annual salary ($)" : "Hourly rate ($)"} id="eR">
                  <input id="eR" type="number" min={0} step="0.01" value={edit.pay?.rate ?? ""} onChange={(e) => setEdit({ ...edit, pay: { ...edit.pay, rate: e.target.value as any } })} />
                </Field>
              </div>
            </>
          )}
          <h4 style={{ margin: "18px 0 8px" }}>Time clock & sign-in</h4>
          <div className="fgrid">
            <Field label={edit.has_pin ? "New PIN (leave blank to keep)" : "Time-clock PIN"} id="ePin" hint="4–6 digits, unique at this hotel">
              <input id="ePin" inputMode="numeric" pattern="\d{4,6}" maxLength={6} autoComplete="off" value={edit.pin || ""} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <Field label={edit.user_id ? "Portal login (linked) — change by email" : "Link to portal login (email)"} id="eLog" hint="Lets them clock in from their phone and see their schedule">
              <input id="eLog" type="email" value={edit.login_email || ""} onChange={(e) => setEdit({ ...edit, login_email: e.target.value })} placeholder="their sign-in email" />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

