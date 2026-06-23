# Robomata Overflow Demo Artifacts

These files are synthetic demo evidence for the Sui Overflow submission video.
They are intentionally not production public-record, insurance, bank, or
telematics integrations.

## Upload Order

Do not select an evidence status manually. Upload each artifact with the package
name, source, and evidence type below. Robomata derives the status from the
active policy and imported receivable data.

1. `receivables-aging-metrofleet-2026-06.csv`
   - Package name: `Receivables aging`
   - Source: `Operator accounting export`
   - Evidence type: `Receivables`
   - Expected derived status: `verified`

2. `insurance-schedule-metrofleet-2026-06.pdf`
   - Package name: `Insurance schedule`
   - Source: `Operator-authorized insurance broker export`
   - Evidence type: `Insurance`
   - Expected derived status: `exception`

3. `title-lien-export-metrofleet-2026-06.pdf`
   - Package name: `Title and lien export`
   - Source: `Commercial lien evidence provider`
   - Evidence type: `Title / lien`
   - Expected derived status: `exception`

4. `lockbox-extract-metrofleet-2026-06.csv`
   - Package name: `Lockbox extract`
   - Source: `Bank lockbox export`
   - Evidence type: `Lockbox`
   - Expected derived status: `exception`

5. `telematics-utilization-metrofleet-2026-06.csv`
   - Package name: `Telematics utilization`
   - Source: `Fleet telematics export`
   - Evidence type: `Servicing / utilization`
   - Expected derived status: `exception`

## Demo Notes

- `AR-2003` is intentionally over the DPD threshold and has a title/lien issue.
- `AR-2004` is intentionally missing insurance evidence.
- `AR-2005` intentionally has lockbox and utilization exceptions.
- Use these exceptions to show policy-governed computation and agentic
  supervision without claiming production lender approval or live third-party
  API integrations.
