/**
 * The location list the request form is built from, as the web app sees it.
 *
 * The API owns the data — it is also what validates a submitted request — so
 * nothing here keeps its own copy of Turkey's provinces or districts. The two
 * halves of the list are fetched at different moments for one reason: every
 * province with its districts is about 14 KB and can be rendered with the form,
 * while the neighbourhood table has some 73,000 rows and is asked for one
 * district at a time.
 */
export type ProvinceWithDistricts = {
  code: string;
  name: string;
  districts: string[];
};
