## 2025-01-20 - Adding ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple places in the app where icon-only buttons exist, but missing aria-labels (e.g. HostSidebar, App.tsx, VaultMenu).
**Action:** The app is completely lacking in aria labels on many elements, especially icon-only buttons. We will add `aria-label` to these buttons to improve accessibility.
