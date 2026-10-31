# Web scanner design contract

Surface: public URL-entry application backed by a bounded local scan service.

User job: enter an authorized public website, start a scan, understand progress, and view or download the report.

Primary action: Scan my website. The form is in the first viewport. A quiet paper/forest palette follows the existing report; a numbered explanation of the four outputs helps set scope without hiding the tool.

Hierarchy: URL and permission → real scan status/cancellation → report summary and downloads → embedded report → next scan.

Viewports: 1440x900 and 390x844. Two-column introduction becomes one column; form controls stack; report metrics use two columns; the report iframe has its own responsive document.

States: empty (URL entry), loading (queued/running progress), error (validation, rate, service, or scan error plus retry), partial (report ready with coverage note), success (report plus downloads), permission (required authorized-use checkbox and private-network refusal). Progress is actual scanner output, without a fabricated completion percentage.

Finish checks: zero automated WCAG A/AA issues at both widths; no horizontal document overflow; usable keyboard focus and labeled controls; form-to-report browser test; correct cancellation/expired state; screenshots at each target size; real scan through the container network boundary.
