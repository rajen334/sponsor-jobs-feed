# sponsor-jobs-feed

A daily feed of UK vacancies at employers that can sponsor a work visa (.NET / C#, QA and testing, and frontline care),
published on GitHub Pages for the Sponsor Jobs UK app.

Every morning a GitHub Actions workflow (`.github/workflows/daily.yml`):

1. downloads the Home Office [register of licensed sponsors](https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers),
   the Irish DETE [employment permits issued to companies](https://enterprise.gov.ie/en/what-we-do/workplace-and-skills/employment-permits/statistics/)
   and the Dutch IND [register of recognised sponsors](https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants);
2. collects jobs from Reed.co.uk, NHS Jobs and NHS Scotland, keeps direct employers with an A-rated Skilled Worker
   licence, and drops adverts that rule sponsorship out, temporary roles and nursing roles;
3. publishes `jobs.js` (the jobs), `meta.json` (when it was updated), `sponsors.js` and `intl-sponsors.js`.

Run it by hand from the **Actions** tab (**Daily jobs feed** → **Run workflow**). The data is public information from the
sources above; the code only reads public job pages. Licence: the government registers are under the Open Government
Licence (UK) and equivalent Irish and Dutch terms.
