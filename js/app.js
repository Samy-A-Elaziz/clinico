/**
 * ==========================================================================
 * CLINICO — APPLICATION SCRIPT
 * ==========================================================================
 * This is the ONLY script that runs the app (index.html loads just this
 * file, plus the small QR-code library used for the PDF export feature).
 *
 * How this file is organised (read top to bottom):
 *   1. Configuration constants  — the few values you're likely to change.
 *   2. Small helper functions   — reusable, self-contained utilities.
 *   3. The ClinicoApp class     — the whole application, split into
 *      clearly-labeled groups of methods:
 *        - Setup / cloud sync
 *        - Navigation between pages ("views")
 *        - The Add/Edit patient form
 *        - Exporting data (XLSX spreadsheet + per-patient PDF report)
 *        - Rendering the patient history list
 *        - Rendering a single patient's details page
 *        - The security PIN modal (used before Edit/Delete)
 *   4. App bootstrap            — creates the app and wires up the
 *      mobile hamburger menus (top navigation + patient action menu).
 * ==========================================================================
 */


/* ============================================================================
   1. CONFIGURATION
   Edit the values in this section to reconfigure the app — no need to touch
   anything below it.
   ============================================================================ */

/**
 * Shown as a patient's photo whenever no image URL has been provided,
 * or when the provided image URL fails to load. It's a small inline
 * cat/paw icon drawn as SVG so the app never depends on an external file.
 */
const PLACEHOLDER_PET_IMAGE = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512' fill='%230d9488'><path d='M226.5 92.9c14.3 42.9-.3 86.6-32.6 107.4-32.4 20.8-74.8 14.5-97.3-14.8-22.5-29.3-16-74.7 14.3-100.7c30.2-26 77.2-20.7 95.6 18.1zM50.4 278.6c0-39.6 33.3-71.7 74.2-71.7 41 0 74.2 32.1 74.2 71.7s-33.3 71.7-74.2 71.7c-41 .1-74.2-32-74.2-71.7zm387.4-185.7c18.4-38.8 65.4-44.1 95.6-18.1 30.3 26 36.8 71.4 14.3 100.7-22.5 29.3-64.9 35.6-97.3 14.8-32.3-20.8-46.9-64.5-32.6-107.4zm74.2 271.7c0 39.6-33.3 71.7-74.2 71.7-41 0-74.2-32.1-74.2-71.7s33.3-71.7 74.2-71.7c41 0 74.2 32.1 74.2 71.7zM362.4 174.4c-11.4-11.4-29.9-11.4-41.3 0l-2.4 2.4-2.4-2.4c-11.4-11.4-29.9-11.4-41.3 0-11.4 11.4-11.4 29.9 0 41.3l23.7 23.7c11.4 11.4 29.9 11.4 41.3 0l23.7-23.7c11.1-11.4 11.1-29.9-1.3-41.3zM256 244c-19.4 0-35.1 15.7-35.1 35.1s15.7 35.1 35.1 35.1 35.1-15.7 35.1-35.1S275.4 244 256 244z'/></svg>";

/**
 * Simple PIN required before a record can be edited or deleted.
 * This is a lightweight deterrent against accidental changes, NOT real
 * security — anyone who reads this file can see the PIN. Do not use it
 * to protect sensitive information; treat it purely as a "confirm you
 * meant to click that" step for veterinary staff sharing one device.
 */
const SECURITY_KEY = "clinico123";

/**
 * The deployed Google Apps Script Web App URL that acts as this app's
 * database. All patient records are read from and written to this
 * endpoint. Replace it with your own deployment URL when setting the
 * app up for a new clinic.
 */
const GOOGLE_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwb2pWSzqZk81Y9j1w3HAZGaAmLITn1NDkGYKQcFxAU3M02J7eTWmkfXJG0GBRJET55/exec";

/**
 * Field names that hold a *list* of cloud file links (X-rays, lab
 * reports, attachments...) rather than plain text. Both the form and
 * the cloud-sync logic use this list to know which fields need the
 * "add another link" row UI and array-style storage.
 */
const DYNAMIC_LINK_FIELDS = [
    'xray', 'ct', 'mri', 'fluoroscopy', 'ultrasound', 'echography',
    'cbc', 'biochemistry', 'urinalysis', 'cytology', 'otherLab',
    'pdf', 'word', 'excel', 'externalFiles'
];


/* ============================================================================
   2. SMALL HELPER FUNCTIONS
   ============================================================================ */

/**
 * Escapes HTML special characters so that patient data (owner names,
 * clinical notes, etc.) can never be interpreted as HTML/JavaScript
 * when it is inserted into the page. Always run free-text values
 * through this before placing them inside an `innerHTML` template.
 * @param {*} value - Any value; non-strings are converted to text first.
 * @returns {string} A safe-to-insert version of the text.
 */
function escapeHtml(value) {
    const text = (value === undefined || value === null) ? '' : String(value);
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * The age field is captured as a number + a unit (Day/Month/Year) so it can
 * always be displayed consistently — e.g. "3 Y", "6 M", "10 D" — in the
 * history list, the patient details page, the exported PDF report, and the
 * exported XLSX spreadsheet.
 *
 * We still store it as a single "<number> <unit>" string (e.g. "3 Y") so
 * the record shape matches the single "age" column already used by the
 * Google Sheets backend — no backend/spreadsheet changes are required.
 */
const AGE_UNIT_LABELS = { D: 'Day(s)', M: 'Month(s)', Y: 'Year(s)' };

/**
 * Combines a number and a unit letter into the stored/displayed age string.
 * @param {string|number} value - The numeric age entered by the vet.
 * @param {string} unit - One of 'D', 'M', 'Y'.
 * @returns {string} e.g. "3 Y", or an empty string if no value was given.
 */
function formatAge(value, unit) {
    const trimmedValue = String(value === undefined || value === null ? '' : value).trim();
    if (trimmedValue === '') return '';
    return `${trimmedValue} ${unit || 'Y'}`;
}

/**
 * Reverses `formatAge()` so an existing record's age can be split back into
 * a number + unit to pre-fill the two form controls when editing.
 * Also makes a best effort to understand older, free-text age values that
 * were typed before this Day/Month/Year selector existed (e.g. "3 Years").
 * @param {string} ageText - The record's stored `age` value.
 * @returns {{value: string, unit: string}}
 */
function parseAgeString(ageText) {
    const text = (ageText === undefined || ageText === null) ? '' : String(ageText).trim();
    if (text === '') return { value: '', unit: 'Y' };

    // Values saved by this app are always "<number> <D|M|Y>".
    const structuredMatch = text.match(/^(\d+(?:\.\d+)?)\s*(D|M|Y)$/i);
    if (structuredMatch) {
        return { value: structuredMatch[1], unit: structuredMatch[2].toUpperCase() };
    }

    // Fall back to interpreting older free-text entries, e.g. "3 Years" or "6 Months".
    const numberMatch = text.match(/^(\d+(?:\.\d+)?)/);
    const value = numberMatch ? numberMatch[1] : '';
    let unit = 'Y';
    if (/day/i.test(text)) unit = 'D';
    else if (/month/i.test(text)) unit = 'M';
    else if (/year|yr/i.test(text)) unit = 'Y';
    return { value, unit };
}

/**
 * Dynamically loads an external script only if it hasn't been loaded yet,
 * then runs a callback. Used to fetch the SheetJS (XLSX) and jsPDF
 * libraries on demand, so the app doesn't pay their download cost until
 * someone actually clicks "Export".
 * @param {string} globalName - The global variable the library defines (e.g. "XLSX").
 * @param {string} src - The CDN URL to load.
 * @param {Function} onReady - Called once the library is available.
 */
function loadLibraryOnce(globalName, src, onReady) {
    if (typeof window[globalName] !== 'undefined') {
        onReady();
        return;
    }
    const scriptTag = document.createElement('script');
    scriptTag.src = src;
    scriptTag.onload = onReady;
    document.head.appendChild(scriptTag);
}


/* ============================================================================
   3. THE APPLICATION
   ============================================================================ */
class ClinicoApp {
    constructor() {
        this.currentView = 'home';
        this.selectedPatientId = null; // remembers which patient is open on the Details page
        this.runtime_db = [];          // in-memory copy of all patient records, loaded from the cloud

        this.initEventListeners();
        this.loadRecordsFromCloud();
    }

    /* ------------------------------------------------------------------
       SETUP / CLOUD SYNC
       ------------------------------------------------------------------ */

    /** Wires up every event listener that only needs to be attached once. */
    initEventListeners() {
        const form = document.getElementById('patient-form');
        if (form) form.addEventListener('submit', (e) => this.handleFormSubmit(e));

        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.addEventListener('input', () => this.renderHistory());

        const speciesSelect = document.getElementById('filter-species-select');
        if (speciesSelect) speciesSelect.addEventListener('change', () => this.renderHistory());

        const exportXlsxBtn = document.getElementById('btn-export-xlsx');
        if (exportXlsxBtn) exportXlsxBtn.addEventListener('click', () => this.exportDatabaseToXLSX());

        // Close the mobile "Export / Edit / Delete" dropdown whenever the
        // user clicks anywhere outside of it.
        document.addEventListener('click', (e) => {
            const openMenu = document.querySelector('.profile-action-cluster.open');
            const wrapper = document.querySelector('.profile-actions-wrapper');
            if (openMenu && wrapper && !wrapper.contains(e.target)) {
                openMenu.classList.remove('open');
            }
        });
    }

    /**
     * Downloads the current patient list from the Google Sheets backend
     * and stores it in `this.runtime_db`. Called once on startup.
     */
    async loadRecordsFromCloud() {
        if (!GOOGLE_WEB_APP_URL || GOOGLE_WEB_APP_URL.includes("YOUR_GOOGLE_APPS_SCRIPT")) {
            console.error("Clinico: no Google Web App URL is configured — patient data cannot be loaded.");
            return;
        }

        try {
            const response = await fetch(GOOGLE_WEB_APP_URL);
            if (!response.ok) throw new Error("Cloud sync response was not OK.");
            const sheetRows = await response.json();

            if (Array.isArray(sheetRows) && sheetRows.length > 1) {
                const headers = sheetRows[0];
                this.runtime_db = sheetRows.slice(1).map((row) => {
                    const record = {};
                    headers.forEach((header, index) => {
                        let value = row[index];
                        // Fields that store multiple links are saved as a
                        // JSON string in the sheet; turn them back into an array.
                        if (DYNAMIC_LINK_FIELDS.includes(header)) {
                            try { value = JSON.parse(value); } catch (e) { value = []; }
                        }
                        record[header] = value;
                    });
                    return record;
                });
                console.log("Clinico: patient database synced from the cloud.");
                if (this.currentView === 'history') this.renderHistory();
            }
        } catch (error) {
            console.error("Clinico: cloud sync failed.", error);
        }
    }

    /* ------------------------------------------------------------------
       NAVIGATION BETWEEN PAGES ("VIEWS")
       ------------------------------------------------------------------ */

    /**
     * Switches which page ("view") is visible: home, add/edit form,
     * history list, or a single patient's details.
     * @param {string} viewName - One of 'home' | 'add' | 'history' | 'details'.
     * @param {string|null} targetId - The patient ID, only needed for 'add' (editing) and 'details'.
     */
    switchView(viewName, targetId = null) {
        this.currentView = viewName;
        this.selectedPatientId = targetId;

        document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
        const activeNavBtn = document.getElementById(`nav-${viewName}`);
        if (activeNavBtn) activeNavBtn.classList.add('active');

        document.querySelectorAll('.view-section').forEach((section) => section.classList.remove('active'));

        if (viewName === 'home') {
            document.getElementById('view-home').classList.add('active');
        } else if (viewName === 'add') {
            this.prepareFormView(targetId);
            document.getElementById('view-add').classList.add('active');
        } else if (viewName === 'history') {
            this.renderHistory();
            document.getElementById('view-history').classList.add('active');
        } else if (viewName === 'details') {
            this.renderDetailsView(targetId);
            document.getElementById('view-details').classList.add('active');
        }

        window.scrollTo(0, 0);
    }

    /* ------------------------------------------------------------------
       ADD / EDIT PATIENT FORM
       ------------------------------------------------------------------ */

    /**
     * Resets and (if editing) pre-fills the patient form.
     * @param {string|null} id - Pass a patient ID to edit that record, or
     *   omit it to prepare a blank form for a new admission.
     */
    prepareFormView(id = null) {
        const form = document.getElementById('patient-form');
        form.reset();

        // Clear out any previously-rendered "add another link" rows.
        DYNAMIC_LINK_FIELDS.forEach((field) => {
            const container = document.getElementById(`wrapper-${field}`);
            if (container) {
                const label = container.querySelector('label');
                container.innerHTML = '';
                if (label) container.appendChild(label);
            }
        });

        if (!id) {
            document.getElementById('form-view-title').innerHTML =
                `<i class="fa-solid fa-file-medical"></i> New Patient Clinical Admission`;
            document.getElementById('field-id').value = '';
            DYNAMIC_LINK_FIELDS.forEach((field) => this.appendDynamicLinkFieldRow(field, ''));
            return;
        }

        const record = this.runtime_db.find((r) => r.id === id);
        if (!record) {
            // The record couldn't be found (e.g. it was deleted from another
            // device). Fall back to a blank "new admission" form instead of
            // leaving the page in a broken, half-set-up state.
            alert("That patient record could not be found. Starting a new admission form instead.");
            document.getElementById('form-view-title').innerHTML =
                `<i class="fa-solid fa-file-medical"></i> New Patient Clinical Admission`;
            document.getElementById('field-id').value = '';
            DYNAMIC_LINK_FIELDS.forEach((field) => this.appendDynamicLinkFieldRow(field, ''));
            return;
        }

        document.getElementById('form-view-title').innerHTML =
            `<i class="fa-solid fa-user-pen"></i> Edit Patient Medical Profile Record`;

        document.getElementById('field-id').value = record.id;
        document.getElementById('field-petName').value = record.petName || '';
        document.getElementById('field-ownerName').value = record.ownerName || '';

        const parsedAge = parseAgeString(record.age);
        document.getElementById('field-age-value').value = parsedAge.value;
        document.getElementById('field-age-unit').value = parsedAge.unit;

        document.getElementById('field-weight').value = record.weight || '';
        document.getElementById('field-species').value = record.species || '';
        document.getElementById('field-breed').value = record.breed || '';
        document.getElementById('field-sex').value = record.sex || '';
        document.getElementById('field-neutered').value = record.neutered || '';
        document.getElementById('field-imageUrl').value = record.imageUrl || '';
        document.getElementById('field-about').value = record.about || '';
        document.getElementById('field-complain').value = record.complain || '';
        document.getElementById('field-symptoms').value = record.symptoms || '';
        document.getElementById('field-syndrome').value = record.syndrome || '';
        document.getElementById('field-diagnosis').value = record.diagnosis || '';
        document.getElementById('field-treatment').value = record.treatment || '';

        DYNAMIC_LINK_FIELDS.forEach((field) => {
            const linksArray = record[field];
            if (Array.isArray(linksArray) && linksArray.length > 0) {
                linksArray.forEach((url) => this.appendDynamicLinkFieldRow(field, url));
            } else {
                this.appendDynamicLinkFieldRow(field, '');
            }
        });
    }

    /**
     * Adds one more "URL + remove button" row to a dynamic link field
     * (e.g. under "X-ray"), and makes sure the "+ Add Link" button stays
     * at the bottom of the list.
     */
    appendDynamicLinkFieldRow(fieldId, value = '') {
        const wrapper = document.getElementById(`wrapper-${fieldId}`);
        if (!wrapper) return;

        const row = document.createElement('div');
        row.className = 'link-input-row';
        row.innerHTML = `
            <input type="url" placeholder="https://external-cloud-vault-storage/file_path" value="${escapeHtml(value)}" class="input-url-element">
            <button type="button" class="btn-row-action btn-remove-row" onclick="this.parentElement.remove()"><i class="fa-solid fa-trash-can"></i></button>
        `;
        wrapper.appendChild(row);

        const existingAddBtn = wrapper.querySelector('.btn-add-row');
        if (!existingAddBtn) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'btn-row-action btn-add-row';
            addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Add Link`;
            addBtn.onclick = () => this.appendDynamicLinkFieldRow(fieldId, '');
            wrapper.appendChild(addBtn);
        } else {
            // Re-append it so it stays below the row we just added.
            wrapper.appendChild(existingAddBtn);
        }
    }

    /** Reads every form field, then saves the record to the cloud. */
    async handleFormSubmit(event) {
        event.preventDefault();
        const existingId = document.getElementById('field-id').value;

        const recordData = {
            id: existingId || ('CLN-' + Math.floor(100000 + Math.random() * 900000)),
            petName: document.getElementById('field-petName').value,
            ownerName: document.getElementById('field-ownerName').value,
            age: formatAge(
                document.getElementById('field-age-value').value,
                document.getElementById('field-age-unit').value
            ),
            weight: document.getElementById('field-weight').value,
            species: document.getElementById('field-species').value,
            breed: document.getElementById('field-breed').value,
            sex: document.getElementById('field-sex').value,
            neutered: document.getElementById('field-neutered').value,
            imageUrl: document.getElementById('field-imageUrl').value,
            about: document.getElementById('field-about').value,
            complain: document.getElementById('field-complain').value,
            symptoms: document.getElementById('field-symptoms').value,
            syndrome: document.getElementById('field-syndrome').value,
            diagnosis: document.getElementById('field-diagnosis').value,
            treatment: document.getElementById('field-treatment').value,
        };

        // Collect every "add another link" field into an array of URLs.
        DYNAMIC_LINK_FIELDS.forEach((field) => {
            const container = document.getElementById(`wrapper-${field}`);
            const inputs = container ? container.querySelectorAll('.input-url-element') : [];
            const values = [];
            inputs.forEach((input) => {
                if (input.value.trim() !== '') values.push(input.value.trim());
            });
            recordData[field] = values;
        });

        try {
            // Note: this request uses `mode: "no-cors"`, which is required by
            // Google Apps Script's web app deployment. It means the browser
            // can't read the response (it comes back "opaque"), so we can't
            // check `response.ok` here — we simply assume success unless the
            // request itself throws (e.g. the device is offline).
            await fetch(GOOGLE_WEB_APP_URL, {
                method: "POST",
                mode: "no-cors",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "SAVE", data: recordData })
            });

            const existingIndex = this.runtime_db.findIndex((r) => r.id === recordData.id);
            if (existingIndex !== -1) {
                this.runtime_db[existingIndex] = recordData;
            } else {
                this.runtime_db.unshift(recordData);
            }

            alert("Clinical record saved successfully.");
            this.switchView('history');
        } catch (error) {
            alert("Could not save this record — please check your internet connection and try again.");
            console.error(error);
        }
    }

    /* ------------------------------------------------------------------
       EXPORTING DATA
       ------------------------------------------------------------------ */

    /** Downloads the entire patient database as an .xlsx spreadsheet. */
    exportDatabaseToXLSX() {
        if (!this.runtime_db || this.runtime_db.length === 0) {
            alert("There are no patient records to export yet.");
            return;
        }

        const buildAndDownloadWorkbook = () => {
            // The left-hand key is the internal field name (also used as the
            // Google Sheets column name); the right-hand label is what the
            // vet actually sees as the column header when they open the file.
            const columnLabels = {
                id: 'Patient ID', petName: 'Animal Name', ownerName: 'Owner Name',
                age: 'Age', weight: 'Mass(Kg)', species: 'Species', breed: 'Breed',
                sex: 'Sex', neutered: 'Neutered', imageUrl: 'Image URL', about: 'About',
                complain: 'Complaint', symptoms: 'Symptoms', syndrome: 'Syndrome',
                diagnosis: 'Diagnosis', treatment: 'Treatment',
                xray: 'X-Ray', ct: 'CT', mri: 'MRI', fluoroscopy: 'Fluoroscopy',
                ultrasound: 'Ultrasound', echography: 'Echography',
                cbc: 'CBC', biochemistry: 'Biochemistry', urinalysis: 'Urinalysis',
                cytology: 'Cytology', otherLab: 'Other Lab',
                pdf: 'PDF Files', word: 'Word Files', excel: 'Excel Files', externalFiles: 'External Files'
            };
            const headersOrder = Object.keys(columnLabels);

            // Flatten each record's link arrays into a single "; "-separated
            // cell so the spreadsheet stays simple and readable, and swap in
            // the friendly column label for each internal field name.
            const sheetRows = this.runtime_db.map((record) => {
                const rowData = {};
                headersOrder.forEach((header) => {
                    let value = record[header];
                    if (value === undefined || value === null) {
                        value = '';
                    } else if (Array.isArray(value)) {
                        value = value.join('; ');
                    }
                    rowData[columnLabels[header]] = value;
                });
                return rowData;
            });

            const worksheet = XLSX.utils.json_to_sheet(sheetRows, { header: headersOrder.map((h) => columnLabels[h]) });
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Clinical Registry Data");

            const dateStamp = new Date().toISOString().slice(0, 10);
            XLSX.writeFile(workbook, `clinico_export_${dateStamp}.xlsx`);
        };

        loadLibraryOnce('XLSX', "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", buildAndDownloadWorkbook);
    }

    /** Builds and downloads a one-page PDF summary for a single patient. */
    exportPatientToPDF(id) {
        const rec = this.runtime_db.find((r) => r.id === id);
        if (!rec) {
            alert("Could not find that patient record.");
            return;
        }

        const buildAndDownloadPdf = async () => {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

            // --- Header banner ---
            doc.setFillColor(13, 148, 136); // Clinico teal
            doc.rect(0, 0, 210, 35, 'F');

            doc.setTextColor(255, 255, 255);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(22);
            doc.text("CLINICO MEDICAL CASE PROFILE", 15, 18);

            doc.setFontSize(11);
            doc.setFont('helvetica', 'normal');
            doc.text(`Patient ID Reference: ${rec.id || 'N/A'}`, 15, 26);
            doc.text(`Report Generation Date: ${new Date().toLocaleDateString()}`, 140, 26);

            doc.setTextColor(40, 40, 40);
            let yCursor = 48;

            const printSectionHeader = (title) => {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(13);
                doc.setTextColor(13, 148, 136);
                doc.text(title.toUpperCase(), 15, yCursor);
                yCursor += 4;
                doc.setDrawColor(200, 200, 200);
                doc.line(15, yCursor, 195, yCursor);
                yCursor += 6;
                doc.setTextColor(60, 60, 60);
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(10);
            };

            // 1. Patient details
            printSectionHeader("1. Patient Details");
            doc.text(`Animal Name: ${rec.petName || 'N/A'}`, 15, yCursor);
            doc.text(`Species: ${rec.species || 'N/A'}`, 75, yCursor);
            doc.text(`Breed: ${rec.breed || 'Unclassified'}`, 140, yCursor);
            yCursor += 6;
            doc.text(`Age: ${rec.age || 'N/A'}`, 15, yCursor);
            doc.text(`Mass(Kg): ${rec.weight || 'N/A'}`, 75, yCursor);
            doc.text(`Sex: ${rec.sex || 'N/A'}`, 140, yCursor);
            yCursor += 6;
            doc.text(`Neutered: ${rec.neutered || 'N/A'}`, 15, yCursor);
            doc.text(`Owner: ${rec.ownerName || 'N/A'}`, 75, yCursor);
            yCursor += 12;

            // 2. Clinical assessment
            printSectionHeader("2. Medical Assessment Summary");
            const assessmentText = doc.splitTextToSize(`${rec.about || 'None documented.'}`, 180);
            doc.text(assessmentText, 15, yCursor);
            yCursor += (assessmentText.length * 5) + 4;

            doc.setFont('helvetica', 'bold');
            doc.text(`Complaint: ${rec.complain || 'None.'}`, 15, yCursor);
            yCursor += 6;
            doc.text(`Symptoms: ${rec.symptoms || 'None.'}`, 15, yCursor);
            yCursor += 6;
            doc.text(`Syndromes: ${rec.syndrome || 'None.'}`, 15, yCursor);
            yCursor += 6;
            doc.text(`Diagnosis: ${rec.diagnosis || 'Pending.'}`, 15, yCursor);
            yCursor += 12;

            // 3. Treatment plan
            printSectionHeader("3. Therapeutic / Treatment Protocol");
            doc.setFont('helvetica', 'normal');
            const treatmentText = doc.splitTextToSize(rec.treatment || 'No treatment plan recorded yet.', 180);
            doc.text(treatmentText, 15, yCursor);
            yCursor += (treatmentText.length * 5) + 12;

            // 4. QR codes linking to every attached file
            if (yCursor < 260) {
                printSectionHeader("4. Medical File Attachments");

                const allLinks = [];
                DYNAMIC_LINK_FIELDS.forEach((field) => {
                    if (Array.isArray(rec[field]) && rec[field].length > 0) {
                        rec[field].forEach((link) => allLinks.push({ field: field.toUpperCase(), url: link }));
                    }
                });

                if (allLinks.length === 0) {
                    doc.text("No files are attached to this patient.", 15, yCursor);
                    yCursor += 10;
                } else {
                    const xPositions = [15, 75, 140];
                    const qrSize = 30;
                    yCursor += 5;

                    for (let i = 0; i < allLinks.length; i++) {
                        const item = allLinks[i];
                        const colIndex = i % 3;
                        const currentX = xPositions[colIndex];

                        if (colIndex === 0 && yCursor > 230) {
                            doc.addPage();
                            yCursor = 20;
                        }

                        doc.text(`${item.field}:`, currentX, yCursor);

                        try {
                            // Type 0 auto-detects the smallest QR size needed;
                            // 'M' is a standard, widely-compatible error-correction level.
                            const qr = qrcode(0, 'M');
                            qr.addData(item.url);
                            qr.make();
                            const qrCodeDataUrl = qr.createDataURL(4);
                            doc.addImage(qrCodeDataUrl, 'GIF', currentX, yCursor + 5, qrSize, qrSize);
                        } catch (err) {
                            console.error("Could not generate a QR code for this link:", err);
                            doc.text("Link Error", currentX, yCursor + 15);
                        }

                        if (colIndex === 2 || i === allLinks.length - 1) {
                            yCursor += 60;
                        }
                    }
                }
            }

            doc.save(`clinico_report_${rec.id || 'export'}.pdf`);
        };

        loadLibraryOnce('jspdf', "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", buildAndDownloadPdf);
    }

    /* ------------------------------------------------------------------
       PATIENT HISTORY LIST
       ------------------------------------------------------------------ */

    /** Renders the searchable/filterable list of patient cards. */
    renderHistory() {
        const grid = document.getElementById('history-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const searchQuery = document.getElementById('search-input').value.toLowerCase().trim();
        const speciesFilter = document.getElementById('filter-species-select').value;

        const filtered = this.runtime_db.filter((rec) => {
            // Guard against records with a missing name/ID (e.g. a partially
            // filled-in spreadsheet row) so search never crashes the page.
            const petName = (rec.petName || '').toLowerCase();
            const patientId = (rec.id || '').toLowerCase();
            const ownerName = (rec.ownerName || '').toLowerCase();

            const matchesSearch = petName.includes(searchQuery) ||
                                   patientId.includes(searchQuery) ||
                                   ownerName.includes(searchQuery);
            const matchesSpecies = (speciesFilter === 'ALL') || (rec.species === speciesFilter);
            return matchesSearch && matchesSpecies;
        });

        if (filtered.length === 0) {
            grid.innerHTML = `
                <div class="no-records-fallback">
                    <i class="fa-solid fa-folder-open"></i>
                    <p>No patient records match your search.</p>
                </div>`;
            return;
        }

        filtered.forEach((rec) => {
            const imgTarget = rec.imageUrl ? rec.imageUrl : PLACEHOLDER_PET_IMAGE;
            const card = document.createElement('div');
            card.className = 'patient-horizontal-card';
            card.onclick = () => this.switchView('details', rec.id);

            card.innerHTML = `
                <div class="card-thumbnail-container">
                    <img src="${escapeHtml(imgTarget)}" onerror="this.src='${PLACEHOLDER_PET_IMAGE}'" alt="Patient Thumbnail">
                </div>
                <div class="card-body-content">
                    <div class="card-meta-top">
                        <div class="card-title-block">
                            <h3>${escapeHtml(rec.petName)}</h3>
                            <div class="card-taxonomic-badges">
                                <span class="badge-species">${escapeHtml(rec.species)}</span>
                                ${rec.breed ? `<span class="badge-breed">${escapeHtml(rec.breed)}</span>` : ''}
                            </div>
                        </div>
                        <span class="card-id-badge">${escapeHtml(rec.id)}</span>
                    </div>
                    <p class="card-preview-text"><strong>Summary:</strong> ${escapeHtml(rec.about)}</p>
                    <div class="card-meta-bottom">
                        <span><i class="fa-solid fa-weight-hanging"></i> Mass(Kg): <strong>${escapeHtml(rec.weight)}</strong></span>
                        <span><i class="fa-solid fa-cake-candles"></i> Age: <strong>${escapeHtml(rec.age)}</strong></span>
                        <span><i class="fa-solid fa-user"></i> Owner: <strong>${escapeHtml(rec.ownerName || 'N/A')}</strong></span>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
    }

    /* ------------------------------------------------------------------
       SINGLE PATIENT DETAILS PAGE
       ------------------------------------------------------------------ */

    /** Renders the full clinical profile for one patient. */
    renderDetailsView(id) {
        const target = document.getElementById('details-view-target');
        const rec = this.runtime_db.find((r) => r.id === id);

        if (!rec) {
            target.innerHTML = `<div class="no-records-fallback"><p>That patient record could not be found.</p></div>`;
            return;
        }

        const profileImg = rec.imageUrl ? rec.imageUrl : PLACEHOLDER_PET_IMAGE;

        /** Turns an array of URLs into a list of clickable links, or a placeholder message if empty. */
        const buildHyperlinkNodes = (linkArray) => {
            if (!Array.isArray(linkArray) || linkArray.length === 0) {
                return `<span class="empty-link-txt">No files attached.</span>`;
            }
            return linkArray.map((url, index) => `
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="clinical-hyperlink">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> File Link #${index + 1}
                </a>
            `).join('');
        };

        target.innerHTML = `
            <div class="profile-action-header">
                <button class="btn btn-secondary" onclick="app.switchView('history')"><i class="fa-solid fa-chevron-left"></i> Return to Registry</button>

                <div class="profile-actions-wrapper">
                    <!-- Hamburger trigger: only visible on small screens (see CSS) -->
                    <button class="actions-toggle-btn" id="actionsToggleBtn" aria-label="Open patient actions menu" aria-expanded="false" onclick="app.toggleActionsMenu(event)">
                        <i class="fa-solid fa-bars"></i>
                    </button>

                    <div class="profile-action-cluster" id="profileActionsMenu">
                        <button class="btn btn-pdf-export" onclick="app.exportPatientToPDF('${rec.id}')"><i class="fa-solid fa-file-pdf"></i> Export</button>
                        <button class="btn btn-primary" onclick="app.requestSecurityAccess('EDIT', '${rec.id}')"><i class="fa-solid fa-user-gear"></i> Edit</button>
                        <button class="btn btn-danger" onclick="app.requestSecurityAccess('DELETE', '${rec.id}')"><i class="fa-solid fa-trash-can"></i> Delete</button>
                    </div>
                </div>
            </div>

            <div class="profile-master-grid">
                <div class="profile-sidebar-panel">
                    <div class="profile-avatar-card">
                        <div class="profile-avatar-wrapper">
                            <img src="${escapeHtml(profileImg)}" onerror="this.src='${PLACEHOLDER_PET_IMAGE}'" alt="Patient Profile">
                        </div>
                        <div class="profile-identity-block">
                            <h2>${escapeHtml(rec.petName)}</h2>
                            <span class="system-id">${escapeHtml(rec.id)}</span>
                        </div>
                    </div>

                    <div class="vitals-list-panel">
                        <h4><i class="fa-solid fa-fingerprint"></i> Biometric Profile</h4>
                        <div class="vital-row"><span class="vital-label">Species:</span><span class="vital-value">${escapeHtml(rec.species)}</span></div>
                        <div class="vital-row"><span class="vital-label">Breed:</span><span class="vital-value">${escapeHtml(rec.breed || 'Unclassified')}</span></div>
                        <div class="vital-row"><span class="vital-label">Age:</span><span class="vital-value">${escapeHtml(rec.age)}</span></div>
                        <div class="vital-row"><span class="vital-label">Mass(Kg):</span><span class="vital-value">${escapeHtml(rec.weight)}</span></div>
                        <div class="vital-row"><span class="vital-label">Sex:</span><span class="vital-value">${escapeHtml(rec.sex)}</span></div>
                        <div class="vital-row"><span class="vital-label">Neutered:</span><span class="vital-value">${escapeHtml(rec.neutered)}</span></div>
                        <div class="vital-row"><span class="vital-label">Owner:</span><span class="vital-value">${escapeHtml(rec.ownerName || 'N/A')}</span></div>
                    </div>
                </div>

                <div class="profile-main-report">
                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-clipboard-list"></i> Clinical Assessment History</h3>
                        <p class="narrative-p"><strong>Assessment:</strong>\n${escapeHtml(rec.about)}</p>
                    </div>

                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-stethoscope"></i> Symptom Profile & Diagnosis</h3>
                        <div class="clinical-subgrid">
                            <div class="subgrid-cell"><h4>Complaint</h4><p>${escapeHtml(rec.complain) || 'None documented.'}</p></div>
                            <div class="subgrid-cell"><h4>Symptoms</h4><p>${escapeHtml(rec.symptoms) || 'None recorded.'}</p></div>
                            <div class="subgrid-cell"><h4>Syndrome</h4><p>${escapeHtml(rec.syndrome) || 'None isolated.'}</p></div>
                            <div class="subgrid-cell"><h4>Diagnosis</h4><p style="color: var(--secondary); font-weight: 600;">${escapeHtml(rec.diagnosis) || 'Pending.'}</p></div>
                        </div>
                    </div>

                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-kit-medical"></i> Therapeutic / Treatment Protocols</h3>
                        <p class="narrative-p" style="border-left-color: var(--accent);">${escapeHtml(rec.treatment) || 'No treatment plan recorded yet.'}</p>
                    </div>

                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-folder-tree"></i> Cloud Diagnostics Data</h3>
                        <div class="asset-link-matrix">
                            <div class="asset-card-node"><h4>X-Ray</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.xray)}</div></div>
                            <div class="asset-card-node"><h4>Computed Tomography (CT)</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.ct)}</div></div>
                            <div class="asset-card-node"><h4>Magnetic Resonance Imaging (MRI)</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.mri)}</div></div>
                            <div class="asset-card-node"><h4>Fluoroscopy</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.fluoroscopy)}</div></div>
                            <div class="asset-card-node"><h4>Ultrasound</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.ultrasound)}</div></div>
                            <div class="asset-card-node"><h4>Echography</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.echography)}</div></div>
                        </div>
                    </div>

                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-microscope"></i> Pathology Laboratory Manifests</h3>
                        <div class="asset-link-matrix">
                            <div class="asset-card-node"><h4>CBC</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.cbc)}</div></div>
                            <div class="asset-card-node"><h4>Biochemistry</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.biochemistry)}</div></div>
                            <div class="asset-card-node"><h4>Urinalysis</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.urinalysis)}</div></div>
                            <div class="asset-card-node"><h4>Cytology</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.cytology)}</div></div>
                        </div>
                        <div class="asset-card-node" style="margin-top: 16px;">
                            <h4><i class="fa-solid fa-vial"></i> Other Labs</h4>
                            <div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.otherLab)}</div>
                        </div>
                    </div>

                    <div class="clinical-block-card">
                        <h3><i class="fa-solid fa-paperclip"></i> Documentation & Attachments</h3>
                        <div class="asset-link-matrix">
                            <div class="asset-card-node"><h4>PDF Files</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.pdf)}</div></div>
                            <div class="asset-card-node"><h4>Word Files (.docx)</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.word)}</div></div>
                            <div class="asset-card-node"><h4>Excel Sheets (.xlsx)</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.excel)}</div></div>
                            <div class="asset-card-node"><h4>External Files</h4><div class="asset-hyperlinks-list">${buildHyperlinkNodes(rec.externalFiles)}</div></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Opens/closes the mobile "Export / Edit / Delete" dropdown menu.
     * Only used on small screens — on desktop the buttons are always visible
     * and this hamburger trigger stays hidden (see the CSS media query).
     */
    toggleActionsMenu(event) {
        event.stopPropagation(); // don't let this click immediately re-trigger the "click outside closes menu" listener
        const menu = document.getElementById('profileActionsMenu');
        const toggleBtn = document.getElementById('actionsToggleBtn');
        if (!menu) return;

        const isNowOpen = menu.classList.toggle('open');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isNowOpen));
    }

    /* ------------------------------------------------------------------
       SECURITY PIN MODAL (required before Edit / Delete)
       ------------------------------------------------------------------ */

    /**
     * Shows the PIN-entry modal before allowing an edit or a delete.
     * @param {'EDIT'|'DELETE'} mode
     * @param {string} id - The patient record this action applies to.
     */
    requestSecurityAccess(mode, id) {
        const modal = document.getElementById('security-modal');
        const passInput = document.getElementById('security-password-input');
        const errorMsg = document.getElementById('security-error');
        const promptTxt = document.getElementById('security-prompt-text');
        const confirmBtn = document.getElementById('security-confirm-btn');

        passInput.value = '';
        errorMsg.style.display = 'none';

        if (mode === 'EDIT') {
            promptTxt.innerText = "You're about to edit this patient record. Enter the access PIN to continue:";
        } else if (mode === 'DELETE') {
            promptTxt.innerText = "Warning: you're about to permanently delete this patient record. Enter the access PIN to confirm:";
        }

        modal.classList.add('active');
        passInput.focus();

        confirmBtn.onclick = async () => {
            if (passInput.value !== SECURITY_KEY) {
                errorMsg.style.display = 'block';
                passInput.select();
                return;
            }

            modal.classList.remove('active');

            if (mode === 'EDIT') {
                this.switchView('add', id);
                return;
            }

            if (mode === 'DELETE') {
                if (!confirm("Are you sure you want to permanently delete this patient record? This cannot be undone.")) return;

                try {
                    // Same "no-cors" limitation as saving: we can't verify the
                    // response, so we optimistically remove the record locally.
                    await fetch(GOOGLE_WEB_APP_URL, {
                        method: "POST",
                        mode: "no-cors",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "DELETE", id: id })
                    });
                    this.runtime_db = this.runtime_db.filter((r) => r.id !== id);
                    alert("Patient record deleted.");
                    this.switchView('history');
                } catch (err) {
                    alert("Could not delete this record — please check your internet connection and try again.");
                }
            }
        };
    }

    /** Closes the PIN modal without taking any action. */
    closeSecurityModal() {
        document.getElementById('security-modal').classList.remove('active');
    }
}


/* ============================================================================
   4. APP BOOTSTRAP
   ============================================================================ */

const app = new ClinicoApp();

document.addEventListener('DOMContentLoaded', () => {
    // Top navigation hamburger menu (Dashboard / New Admission / Archives)
    const navToggleBtn = document.getElementById('navToggleBtn');
    const navButtonsMenu = document.getElementById('navButtonsMenu');

    if (navToggleBtn && navButtonsMenu) {
        navToggleBtn.addEventListener('click', () => {
            const isNowOpen = navButtonsMenu.classList.toggle('active');
            const icon = navToggleBtn.querySelector('i');
            if (icon) icon.className = isNowOpen ? 'fas fa-times' : 'fas fa-bars';
        });
    }
});
