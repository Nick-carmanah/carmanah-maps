# Layers that round-trip with Avenza Maps

Written 2026-11-18 with the change that made imported data editable (plan
§5, Phases A2, A3 and the Phase B data model). This is the reference for how
we read and write layer files, and the list of assumptions to check against
a real Avenza Pro export when one is available.

## The model

`src/lib/layers.ts`. One model for drawn and imported data ("My Data"):

| Layer field | Meaning |
|---|---|
| `id`, `name` | |
| `parentId` | Sublayers. Undefined = top level. |
| `order` | Position among siblings. |
| `visible` | Saved show/hide. A layer is drawn only if it and every parent are visible. |
| `style` | Default for new features: `color`, `width`, `fill`, `fillOpacity`, `symbol`. |
| `schema` | Typed attributes: `{ name, type: string \| boolean \| integer \| real, picklist? }`. |
| `source` | Where an imported layer came from (file, link, format, date). |

Each feature (`UserFeature`, `src/lib/features.ts`) has a `layerId`, its own
style (`color`, `width`, `fill`, `fillOpacity`, `symbol`, `iconHref`), area
`holes`, track `times`, and `attributes` as ordered text values. Keys in the
layer schema are typed fields; any other key is a per-feature field (Avenza
has both).

Storage: two new stores, `layers` and `icons` (KMZ icon images), in the
existing database via `src/lib/store.ts` (DB v6). Photos stay in `photos`.
`writeBatch` writes an import, the migration or a layer delete in one
transaction. All access goes through `store.ts`, so moving these stores into
the per-owner database (`carmanah-maps.<ownerId>`, from the maps-library
work) only touches that file.

**Migration** (`src/lib/mydata.ts`, runs once, flag `migrated:layers-v1`):
each old layer *name* becomes a top-level layer; each old read-only overlay
(`overlays` store) becomes a layer of editable features with its attributes
and KML styles. The overlay records are left untouched as a backup and
nothing writes to that store any more.

**Read API** for anything that draws My Data elsewhere (the send-area-as-
GeoPDF writer): `visibleStyledFeatures(layers, features)` in `layers.ts`,
`loadVisibleStyledFeatures()` in `mydata.ts`, and `symbolPng(symbol)` in
`symbols.ts` for pin icons.

## Reading (`src/lib/kml.ts`, `src/lib/importers.ts`)

Everything lands in editable layers: KML, KMZ, GPX, CSV, zipped shapefile,
GeoJSON. The extension is a hint only: archives and text are sniffed (a KML
inside a `.zip` works; a shapefile `.zip` with several `.shp` becomes a layer
with one sublayer each).

KML/KMZ:
- `<Folder>` (or nested `<Document>`) → layer; nesting → sublayers. Hidden
  folders (`<visibility>0`) come in hidden. Placemarks directly under the
  Document go into a layer named after the Document. Empty folders with a
  schema still make a layer (that's Avenza's "schema only" export).
- Attributes from `<SchemaData>/<SimpleData>` (typed by the `<Schema>`'s
  `SimpleField type`) and from `<ExtendedData><Data>` (per-feature, text).
  A schema that only placemarks point at (QGIS, ArcGIS) becomes the layer's.
- Picklists from Avenza's `<avenza:picklist>` (Document `ExtendedData`).
- Notes: the `Description` field if present, else `<description>` as plain
  text (HTML stripped, line breaks kept).
- Styles: shared `<Style>`, `<StyleMap>` (normal pair) and inline `<Style>`;
  line colour and width, fill colour and opacity (`<fill>0` = none,
  `<outline>0` = no outline), icon colour, icon href.
- Icons: an icon file inside the KMZ is stored and drawn as the pin symbol;
  one whose name matches our symbol set (built-in fire-ops or NWCG, by key,
  file name or label) becomes that symbol. A remote icon (Avenza's own pins,
  Google's pushpins) is never fetched: the colour word in its name colours
  the pin and the URL is kept so a re-export shows the same icon.
- Photos: images in `pdfmaps_photos`, images in `<description>`, older
  Avenza "Photo Name" lists; resolved against any path in the KMZ
  (`images/`, `files/`, URL-encoded names, case-insensitive, by file name).
- Geometry: Point, LineString, LinearRing, Polygon with holes, MultiGeometry
  (split into one feature per part), `gx:Track` and `gx:MultiTrack` with
  their timestamps. "lon, lat" with spaces, altitude kept; an altitude of 0
  on every vertex is dropped (many tools write 0 for "none").
- Skipped with a warning: ground/screen/photo overlays, network links,
  placemarks with no usable coordinates.

GPX: waypoints → pins (name, description, time, `<sym>` matched to our
symbols), tracks → lines with per-point times, routes → lines. CSV: latitude
and longitude columns detected by name (lat/latitude/y…, lon/lng/long/x…,
also "Nom"), or a single coordinates / WKT `POINT` / MGRS / UTM column, or
zone + easting + northing; decimal comma, DMS and DDM values; swapped
columns fixed; `;`/tab delimiters; other columns become attributes with
inferred types. Our own pre-layers CSV (`kind,measurement,attributes`) is
read too. Shapefile: DBF types become the schema.

## Writing (`src/lib/export.ts`)

Export sheet: pick layers (a parent ticks its sublayers), format, include
photos (KMZ), tracks as lines. The ✎ row's **Share** sends that layer and its
sublayers as KMZ with photos. Sharing goes through `shareOrDownload` (Web
Share → AirDrop on iPhone, download elsewhere).

KMZ = `doc.kml` (first entry) + `files/` (icons) + `images/` (photos):

```xml
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"
     xmlns:avenza="http://www.avenza.com" xmlns:carmanah="https://carmanahwildfire.com/ns/maps/1">
<Document>
  <name>…</name>
  <Style id="style0">…</Style> …                 one per distinct look
  <ExtendedData>
    <avenza:picklist schemaUrl="schema0" avenza:field="Crew"><avenza:picklistvalue><![CDATA[Alpha]]></avenza:picklistvalue>…</avenza:picklist>
    <carmanah:feature ref="f2" symbol="helispot" color="#1d4ed8"/>   symbol keys, geofences
  </ExtendedData>
  <Schema id="schema0" name="schema0">          one per layer, Avenza's built-ins first
    <SimpleField type="string" name="Description"/>
    <SimpleField type="string" name="pdfmaps_photos"><displayName>Photos</displayName></SimpleField>
    <SimpleField type="bool" name="Done"/>        string / bool / int / double
  </Schema>
  <Folder id="L1">
    <name>Day 3</name>
    <styleUrl>#style7</styleUrl>                   layer default style
    <ExtendedData><SchemaData schemaUrl="#schema0"/></ExtendedData>
    <Placemark id="f1">
      <name/><description>notes + <img> for Google Earth</description>
      <TimeStamp><when>created</when></TimeStamp>
      <styleUrl>#style0</styleUrl>
      <ExtendedData>
        <Data name="per-feature field"><value>…</value></Data>
        <SchemaData schemaUrl="#schema0">
          <SimpleData name="Description">notes</SimpleData>
          <SimpleData name="pdfmaps_photos"><![CDATA[<img src="images/White_pin.jpg" /><br />]]></SimpleData>
          <SimpleData name="Done">true</SimpleData>
        </SchemaData>
      </ExtendedData>
      <Point|LineString|Polygon(+innerBoundaryIs)|gx:Track/>
    </Placemark>
    <Folder>…sublayer…</Folder>
  </Folder>
</Document></kml>
```

Plain KML 2.2 in schema element order. The only extensions are `gx:Track`
(Google's, read by Avenza and Google Earth) and namespaced elements inside
the Document's `<ExtendedData>`, which KML 2.2 allows for any XML in another
namespace; Avenza writes its picklists there itself. Plain-dot pins use a
white `files/dot.png` tinted by `IconStyle/color`; symbol pins embed their PNG
(`files/helispot.png`, `files/nwcg-….png`, imported icons). KML export is the
same without photos or icon files. GPX: waypoints, lines/tracks (with times
unless "tracks as lines"), areas as closed tracks. CSV: placemarks only;
Name, Latitude, Longitude, Altitude, Description, Layer (path), Symbol,
Color, Created, then one column per attribute.

## Evidence used (no decompiling)

- Avenza help centre: *Attribute Schema*, *Working with Attribute Schemas*,
  *Exporting and sharing map features*, *Importing Map Features*. Types are
  String, Boolean, Real, Integer, each with an optional pick list; schemas
  travel only as KML; export options are data/schema-only, photo size and
  "convert tracks to lines".
- Publicly posted KML files exported by Avenza (found with GitHub code search
  for `pdfmaps_photos`), studied for structure only, and two open-source
  tools that read Avenza KMZ (the `avenza_kmz_importer` QGIS plugin and a KMZ
  image extractor). These show: `schemaN` schemas with built-in `Description`
  and `pdfmaps_photos` fields; types `string`/`bool`/`int`/`double`;
  `avenza:picklist` elements; one `<Folder>` per layer with a `styleUrl` and
  an empty `<SchemaData>`; placemark `<TimeStamp>`; `gx:Track` tracks with a
  `track_schema` (speed, accuracy); built-in pins as remote
  `download.avenza.com/images/pdfmaps_icons/<colour>_pin.png` hrefs; photos
  in `images/` listed as `<img src="images/NAME.jpg" /><br />` HTML.
- KML 2.2 (OGC 07-147r2) for element order and `ExtendedData`.
- Test fixtures are synthetic and live only in the gitignored `samples/`.

## Assumptions to confirm with a real Avenza Pro export

1. **Photos go in `images/`, not `files/`.** Avenza's own KMZs use `images/`
   and the `pdfmaps_photos` field, so we write photos that way; icons go in
   `files/` (Google Earth's convention). We read photos from any folder.
2. **Notes in both places.** We put the notes in the `Description` field (for
   Avenza) and in `<description>` with the photos (for Google Earth). If
   Avenza shows the notes twice, drop them from `<description>` (one line in
   `export.ts`).
3. **Where Avenza puts custom icons inside a KMZ** is unknown; we resolve any
   relative href, so this only matters for what we write (`files/`).
4. **Booleans** are written `true`/`false`; we read true/false/yes/no/y/n/1/0.
5. **Per-feature fields** (not in the layer schema) are written as `<Data>`.
   If Avenza ignores `<Data>`, promote them into the layer schema on export.
6. **Avenza ignores our `carmanah:` elements** in the Document `ExtendedData`
   (it keeps its own picklists there, so its reader tolerates that element).
7. **Hidden layers** are written with `<visibility>0</visibility>`; Avenza
   may show them anyway.
8. **Track extras** (Avenza's speed and accuracy arrays) are not imported and
   not written; times and altitudes are.
9. **Photo size** (Avenza's Small/Medium/Large) isn't offered: originals go
   out as they are, with their own extension (`.jpg`, `.png`, `.heic`).
   Avenza may only show JPEGs.
10. **GPX areas**: Avenza's GPX has no areas; we write them as closed tracks.
11. **CSV column names** in Avenza's own CSV export are unknown; the reader
    detects coordinates broadly.

## How it was verified

A browser harness (gitignored, `samples/layers-harness/`; a copy is in the
session notes folder) runs against the real modules on the dev server:

- Avenza-style KMZ import: folder tree, typed schema and picklists (empty
  picklists ignored), folder default style, notes from `Description`,
  attributes, Avenza pin colours with href kept, altitude, created time,
  photos (3, bytes intact, right placemarks), custom icon (bytes intact),
  `gx:Track` times, area style.
- Google Earth-style KML: StyleMap, `<Data>`, HTML description, "lon, lat"
  with a space, polygon hole, MultiGeometry split, warnings for overlays and
  empty placemarks.
- Round trip our KMZ → our import: identical layers (tree, visibility,
  schema with types and picklists, default style) and features (geometry
  including holes and altitude, notes with `< & " ]]>` and newlines, styles,
  symbols, remote icon hrefs, attributes, track times, geofences, created
  time), photos byte-identical in order, imported icon byte-identical.
- KML-only round trip (no files), GPX and CSV round trips (what each format
  holds), five CSV dialects, our old CSV, zipped shapefiles through `shpjs`.
- `@tmcw/togeojson` reads our `doc.kml`: same feature count, typed
  SchemaData values, notes, colours, `gx:Track` times, polygon hole, folder
  tree.
- Migration on a real v5 IndexedDB seeded with old records: layers from old
  names, every field kept, overlay → editable features with styles and
  attributes, photo still linked, overlay kept as backup, flag set, second
  load adds nothing.
- In the app: drop a KMZ → layers, map fit, pins, icon, photo on the edit
  sheet, typed attribute form, layer editor, export sheet → KMZ that
  re-imports with 7 layers, 11 features, 4 photos, 1 icon.
