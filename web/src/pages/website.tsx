// Website enquiries and job applications sent from the company's own website.
// Enquiries: Company information permission. Job applicants (with résumés): Workforce edit (HR).
import React, { useState } from "react";
import { db, storage } from "../lib/sb";
import { Ctx, fmtDate } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Notice, Tabs, downloadFile, toCsv } from "../ui";

type Sub = { id: string; kind: "contact" | "application"; first_name: string | null; last_name: string | null; phone: string | null; email: string;
  message: string | null; position: string | null; linkedin: string | null; resume_path: string | null; resume_name: string | null;
  status: "new" | "contacted" | "closed" | "spam"; page: string | null; created_at: string };
const STATUS: Record<Sub["status"], [string, "warn" | "info" | "good" | "mute"]> = { new: ["New", "warn"], contacted: ["Contacted", "info"], closed: ["Done", "good"], spam: ["Spam", "mute"] };

export function Website({ ctx }: { ctx: Ctx }) {
  const seeEnq = ctx.can("company"), seeApps = ctx.can("workforce", "edit");
  const [tab, setTab] = useState<"contact" | "application">(seeEnq ? "contact" : "application");
  const [show, setShow] = useState<"open" | "all">("open");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const canEdit = tab === "contact" ? ctx.can("company", "edit") : seeApps;
  const q = useAsync(() => db.getAll<Sub>(`website_submissions?select=*&tenant_id=eq.${ctx.tenant.id}&kind=eq.${tab}&order=created_at.desc,id.asc`, 5000), [tab]);
  const rows = (q.data || []).filter((r) => show === "all" || r.status === "new" || r.status === "contacted");
  const counts = (k: Sub["kind"]) => (k === tab ? (q.data || []).filter((r) => r.status === "new").length : 0);

  async function setStatus(r: Sub, status: Sub["status"]) {
    try { await db.update("website_submissions", `id=eq.${r.id}`, { status, updated_at: new Date().toISOString() }, "id"); q.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function openResume(r: Sub) {
    try { window.open(await storage.signedUrl("applicants", r.resume_path!, 120), "_blank", "noopener"); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  function exportCsv() {
    const head = tab === "contact" ? ["Received", "Name", "Email", "Phone", "Message", "Status"] : ["Received", "Name", "Email", "Phone", "Position", "LinkedIn", "Status"];
    const body = (q.data || []).map((r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ");
      return tab === "contact" ? [r.created_at.slice(0, 10), name, r.email, r.phone, r.message, STATUS[r.status][0]]
        : [r.created_at.slice(0, 10), name, r.email, r.phone, r.position, r.linkedin, STATUS[r.status][0]];
    });
    downloadFile(`website-${tab === "contact" ? "enquiries" : "applicants"}-${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + toCsv([head, ...body]));
  }

  const tabs: ["contact" | "application", string][] = [];
  if (seeEnq) tabs.push(["contact", `Enquiries${counts("contact") ? ` (${counts("contact")} new)` : ""}`]);
  if (seeApps) tabs.push(["application", `Job applicants${counts("application") ? ` (${counts("application")} new)` : ""}`]);
  return (
    <>
      <PageHead eyebrow="Company" title="Website" desc="Messages and job applications sent from your website's forms."
        actions={<button className="btn" onClick={exportCsv} disabled={!q.data?.length}>Export</button>} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      <div className="toolbar">
        <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as any)}><option value="open">New and in progress</option><option value="all">Everything</option></select>
      </div>
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : (
        <Card flush>
          {!rows.length ? <Empty title={tab === "contact" ? "No enquiries yet." : "No applications yet."}>They appear here the moment someone sends the form on your website.</Empty> : (
            <div className="tw"><table>
              <thead><tr><th>Received</th><th>From</th>{tab === "contact" ? <th>Message</th> : <><th>Position</th><th>Résumé</th></>}<th>Status</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap small">{fmtDate(r.created_at.slice(0, 10))}</td>
                  <td><b>{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</b>
                    <div className="small"><a href={`mailto:${r.email}`}>{r.email}</a>{r.phone && <> · <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a></>}</div></td>
                  {tab === "contact" ? <td className="small" style={{ maxWidth: 520, whiteSpace: "pre-wrap" }}>{r.message}</td> : <>
                    <td className="small">{r.position}{r.linkedin && /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(r.linkedin) && <div><a href={r.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a></div>}</td>
                    <td>{r.resume_path && <button className="btn sm" onClick={() => openResume(r)}>Open</button>}</td></>}
                  <td>{canEdit
                    ? <select aria-label="Status" value={r.status} onChange={(e) => setStatus(r, e.target.value as Sub["status"])}>
                        {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
                    : <Pill kind={STATUS[r.status][1]}>{STATUS[r.status][0]}</Pill>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </>
  );
}
