# Satellite imagery: what we may show, save offline and print

Checked 2026-11-18 against each provider's own terms (links and quotes below).
This is a reading of published terms, not legal advice. Where a row says
"written permission" or "quote", that is the only way to be sure.

## The question

Carmanah Maps ships inside a commercial crew app. Crews work offline for hours
or days, so any imagery we show has to be:

1. **saved on the phone** ahead of time (whole-fire offline areas, about
   100 × 100 km), and
2. **printed into exported maps** ("Send this area as a map" GeoPDFs that go
   to people using Avenza).

Today the satellite layer is Esri World Imagery, fetched from
`server.arcgisonline.com` with no account (`src/map/basemap.ts`). The service
worker keeps every tile it sees for 90 days (`vite.config.ts`). "Save offline"
doesn't download satellite tiles; the export doesn't offer satellite.

## Recommendation

1. **Use the free Copernicus Sentinel-2 quarterly mosaics, turned into our own
   BC tiles.** This is the only free source that is recent *and* clearly
   allowed offline and in exports. The newest one over BC covers
   **July to September 2026**, so it shows this season's burns. The data
   licence allows copying, sharing and changing it, commercial use included,
   as long as we credit it. The catch is that it's 10 m imagery (lakes,
   burns, cutblocks, big roads; not trails, dozer guards or buildings), and
   there's no ready tile server. We build the tiles once per season and host
   them ourselves, the same way regional basemap packs are planned.
2. **Short-term fix, no setup: EOX Sentinel-2 cloudless 2016.** It's
   CC BY 4.0, and EOX says in writing that commercial mobile apps may use its
   free 2016 tile server and cache the tiles on the device. It's 10 m and
   **ten years old**: it misses every fire since 2016, including the 2017,
   2018, 2021 and 2023 seasons. If we use it, the layer has to say "2016" on
   screen.
3. **Esri: online only, or remove it.** Esri's terms allow offline basemaps
   only through Esri Content Packages in Esri software, and forbid harvesting
   or redistributing tiles. We can't save it offline or print it. Online-only
   use would also need an ArcGIS account and token. A layer that vanishes
   offline is confusing in the field, so drop it once a replacement lands.
4. **If crews need sub-metre imagery offline**, it's paid and quoted:
   MapTiler On-prem (Custom plan, high-res add-on), or a direct licence from
   an imagery company. The other paid options (Mapbox, MapTiler Cloud, Esri's
   developer plans) are online only for an app like ours.

## Summary table

Resolution is what a crew sees at full zoom. "z14" ≈ 5.6 m per screen pixel
at 54° N; 10 m imagery is sharpest around z13–z14 and is stretched beyond.

### Allowed offline and in exported maps

| Source | Offline on phones | In exported PDFs | Cost | Resolution over BC | Imagery date | Endpoint | Credit to show |
|---|---|---|---|---|---|---|---|
| **Copernicus Sentinel-2 quarterly mosaics** (recommended) | ✅ free, full and open; we host our own copy | ✅ with credit | Free data; we pay hosting (~10–20 GB for all of BC) and build time | 10 m | Quarterly; newest over BC: Jul–Sep 2026 | None ready-made. Cloud-optimised GeoTIFFs (`sentinel-2-global-mosaics` STAC collection) → our PMTiles | `Contains modified Copernicus Sentinel data 2026` |
| **EOX Sentinel-2 cloudless 2016** (short-term) | ✅ CC BY 4.0; EOX says cache on your device or CDN | ✅ with credit printed on the map | Free; no uptime promise; fair use | 10 m, z0–14 | 2016 | WMTS/XYZ: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg` | `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)` |
| EOX Sentinel-2 cloudless 2018–2025, commercial licence | ✅ in-app caching and offline packs | ✅ with credit printed on the map | €5,000 per past year, €6,000 for 2025 (one-off, worldwide); hosted endpoint €6,000/yr | 10 m, z0–14 | Yearly; latest 2025 | Delivered as a whole-world file (856 GB for 2025), or their paid endpoint | Same as above, with the year |
| MapTiler On-prem, Standard | ✅ (built for offline) | 🟡 50 prints/month, internal only | US$2,500/yr | "Medium-Res" (not stated per region) | Not stated | Download, self-host | MapTiler's credit |
| MapTiler On-prem, Custom (high-res) | ✅ | ✅ "internal or external" | Quote | "High-Res" add-on | Not stated | Download, self-host | MapTiler's credit |
| NRCan GeoBase Orthoimages 2005–2010 | ✅ OGL – Canada | ✅ with credit | Free | 10 m (pan) / 20 m (colour) | 2005–2010; "no longer supported" | GeoTIFF files only (FTP) | OGL – Canada credit |
| USGS / NAIP | ✅ US federal public data | ✅ | Free | 0.6–1 m | Service refreshed June 2024 | `basemap.nationalmap.gov` USGSImageryOnly (z0–16) | `USDA, USGS The National Map: Orthoimagery` |

NAIP covers the **United States only** (the lower 48 at full detail). No use
in BC; only worth a thought for crews deployed south of the border.

### Online only, or not usable at all

| Source | Offline on phones | In exported PDFs | Cost | Resolution over BC | Imagery date | Endpoint | Credit |
|---|---|---|---|---|---|---|---|
| **Esri World Imagery** (what we use now) | ❌ only Esri Content Packages in Esri software | ❌ (static maps only for licensed Esri users, in reports; not exports from a non-Esri app) | Needs an ArcGIS account or token: 2M tiles free, then US$0.15 per 1,000 | "one meter or better" for most land (Vantor Vivid Standard 0.6–1.2 m) | "typically within 3-5 years" | `World_Imagery/MapServer/tile/{z}/{y}/{x}` | `Esri, Vantor, Earthstar Geographics, and the GIS User Community` (+ "Powered by Esri") |
| Mapbox Satellite | ❌ offline only through Mapbox's own iOS/Android SDKs, not MapLibre; no preloading or redistributing | ❌ print use: "contact us" | Metered | High-res, varies | Not stated | Raster tiles API (`mapbox.satellite`) | © Mapbox |
| MapTiler Cloud Satellite | ❌ single-user temporary cache only; no bulk download; no export outside the service | ❌ A4 at 300 DPI, internal use, plan limits | Monthly plans; free plan is non-commercial | High-res, varies | Not stated | MapTiler Cloud API | MapTiler's credit |
| EOX 2018–2025 free tile server | ❌ "strictly prohibited" for commercial apps | ❌ | — | 10 m | — | — | — |
| **BC Government imagery WMS** | ❌ "Access Only": no reproduction without written permission | ❌ same | Free to view | 1 m province-wide; some areas finer | Province-wide mosaics 1995–2007; patchy regional ones (mostly 1995–2013) | WMS: `openmaps.gov.bc.ca/imagex/ecw_wms.dll` (not tiled) | — |
| BC Government orthophotos (bought per map sheet) | ❌ without written permission | ❌ same | C$200 per 1:20,000 sheet | 1 m, some 0.5 m | Varies by sheet | TIFF on disk, posted | — |
| Google Earth / Google satellite | ❌ (see README) | ❌ | — | — | — | — | — |

---

## Esri World Imagery: the terms as written

**World Imagery item page**
([arcgis.com item 10df2279…](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)):

> **Export:** This layer is not intended to be used to export tiles for
> offline. If you would like to export imagery for offline use in ArcGIS
> applications, you may use the World Imagery (for Export) layer, which is
> intended for this purpose.

Its Credits field reads **"Esri, Vantor, Earthstar Geographics, and the GIS
User Community"** (the service itself says "Source: Esri, Vantor, Earthstar
Geographics, and the GIS User Community"). Our map still says "Maxar".

The [World Imagery (for Export)](https://www.arcgis.com/home/item.html?id=226d23f076da478bba4589e7eae95952)
layer "requires an ArcGIS Online organizational subscription or an ArcGIS
Developer account".

**Esri's terms-of-use summary**
([tou_summary.pdf](https://www.esri.com/content/dam/arcgisonline/docs/tou_summary.pdf),
last updated April 21, 2025), linked as "View Summary" from the item page:

> Use the basemap data offline in the following manner.
> • The data may only be taken offline using Esri Content Packages
> • The package can be used with any device as long as it is used exclusively
> with Esri software.

> Use with Esri software and comply with its terms of use. If you do not have
> Esri software, you must purchase an ArcGIS Online subscription.

> YOU MAY NOT
> Systematically harvest basemap tiles through any method other than using
> Esri Content Packages
> Redistribute basemap tiles
> Download, redistribute or self-host any content hosted by Esri.

**Esri Master Agreement**
([E204, revised August 14, 2026](https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf)),
"View Terms of Use" from the item page, section 3.2:

> a. Unless otherwise authorized in writing, Customer may only use Data with
> the Products for which Esri has provided the Data.

> c. Customer may not otherwise scrape, download, or store Data, except as
> follows
> 1. Customer may take Online Services basemaps offline through Esri Content
> Packages and subsequently deliver (transfer) them to any device for use with
> licensed ArcGIS Runtime SDKs (ArcGIS Maps SDKs for Native Apps) applications
> and ArcGIS Desktop or ArcGIS Pro.

Section 3.2(b) does allow a licensed customer to make "hard-copy or static,
electronic format (e.g., PDF …) representations of Data … for visualization
purposes only" and put them "in reports … to third parties", with credit.
That is a narrow reports allowance for Esri customers, not a right to
store tiles in a non-Esri app and build maps from them. Esri's
[static maps page](https://doc.esri.com/en/arcgis-online/latest/reference/static-maps.html)
adds that uses beyond personal, internal, client reports and marketing,
"commercial monetization and direct resale" included, need Esri's permission
first.

**Esri product-specific terms**
([E300, November 10, 2026](https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf)),
footnote 10:

> Programmatic use of session tokens (e.g., exporting volumes of basemap
> tiles) is not permitted.

**Esri developer route.** The
[offline mapping FAQ](https://developers.arcgis.com/documentation/offline-mapping-apps/faq/)
says: "If you have an ArcGIS Location Platform account and would like to build
offline applications, please contact Esri." Offline in Esri's model means the
ArcGIS Maps SDKs, not MapLibre. Online use with a token is metered
([pricing](https://location.arcgis.com/pricing/): basemap tiles "2M free then
$0.15 per 1,000 tiles").

**What this means for us:** today the service worker keeps Esri tiles for
offline use, which the terms forbid, and we use the service without an
account. Printing it into exported maps would break the terms too, which is
why the send-area export (PR #13) leaves satellite out.

## BC Government imagery (Open Government Licence – BC?)

The Province's imagery is **not** under the Open Government Licence – BC.

- The BC Data Catalogue lists the
  [Imagery Web Map Service](https://catalogue.data.gov.bc.ca/dataset/73b2a989-df6b-4298-bd38-c60f0254a453),
  the [SPOT 15 m service](https://catalogue.data.gov.bc.ca/dataset/bcad8f9e-274b-4a29-9e06-d05def3a50c2),
  the [Landsat service](https://catalogue.data.gov.bc.ca/dataset/ac0a7aa9-f56d-45b1-bd17-8554843de6a5)
  and the orthophoto indexes as **"Access Only"**. The Province's
  [copyright page](https://www2.gov.bc.ca/gov/content/home/copyright) says such
  materials are "access only" and "reproduction is not permitted without
  written permission."
- The WMS's own capabilities say: "This Web Map Service cannot be cascaded
  through another Web Map Service without the express written permission of
  the Province of British Columbia".
- What's in it is old: a province-wide 1 m colour mosaic from 1995–2004, SPOT
  15 m from 2004–2006, Landsat 2006, and patchy regional mosaics (mostly
  1995–2013). It's a plain WMS (`ecw_wms.dll`), not a tile service.
- Full-resolution [orthophotos](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/digital-imagery/orthophotos)
  are sold per map sheet ($200 per 1:20,000 sheet; "Most images have a pixel
  resolution of 1 metre, with some colour orthophotos available at 0.5 metre
  resolution"), shipped as TIFF files on disk, with no open licence stated.
- LidarBC data **is** under OGL – BC, but that's elevation, not imagery.

To use BC imagery we'd need the Province's written permission (the
[Copyright Permission Request Form](https://www2.gov.bc.ca/gov/content/home/copyright)).
Given how old it is, not worth chasing for satellite view.

## Natural Resources Canada / GeoBase

- [Orthoimages of Canada, 2005-2010](https://open.canada.ca/data/en/dataset/d799c202-603d-4e5c-b1eb-d058803f80f9):
  Open Government Licence – Canada, so offline and export are fine. But: "This
  collection is a legacy product that is no longer supported", SPOT 4/5 with
  "a panchromatic band having 10 m pixels and four multispectral bands having
  pixels of 20 m", delivered as large GeoTIFFs over FTP. Older and coarser
  than Sentinel-2.
- The NRCan basemaps (Canada Basemap – Transportation and its French
  version) are drawn maps, not imagery.

## Sentinel-2 cloudless by EOX, year by year

From EOX's [FAQ](https://cloudless.eox.at/documentation/faq),
[licence summary](https://cloudless.eox.at/documentation/license),
[pricing](https://cloudless.eox.at/pricing) and its
[WMTS capabilities](https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml):

| Year | Licence | Commercial use of the free tile server | Commercial use otherwise |
|---|---|---|---|
| 2016 (`s2cloudless_3857`) | CC BY 4.0 | ✅ "provided traffic is reasonable" | ✅ |
| 2017 (`s2cloudless-2017_3857`) | WMTS text says CC BY 4.0; the FAQ and pricing only name 2016 | Ask EOX first | Ask EOX first |
| 2018–2025 | CC BY-NC-SA 4.0 (non-commercial) | ❌ | Paid licence |

> Yes, the 2016 vintage is published under the CC BY 4.0 license. You may use
> this data as an embedded basemap in commercial mobile apps, B2B portals,
> video templates, and websites, provided you: Comply with the required
> attribution. Accept that the free public tile endpoint offers no uptime
> Service Level Agreement (SLA). Do not resell or redistribute the raw source
> tiles as a standalone GIS dataset. Accept that a Fair Use Policy applies.

> 2018+ Layers: No. Using the public WMS/WMTS endpoints for commercial
> production apps is strictly prohibited. Commercial use requires purchasing
> the offline cache or subscribing to a dedicated hosted endpoint.

> To keep your app running smoothly on our free endpoints, cache tiles on your
> own CDN or device, and spread out your requests rather than sending large
> batches all at once.

Under the paid licence:

> Both standard in-app network caching and user-initiated regional offline
> pack downloads are fully permitted under the commercial license, as long as
> the tiles remain embedded within your application environment and cannot be
> extracted as raw data by end-users.

Prices (excluding VAT, one-off, perpetual, worldwide, no per-user caps):
€6,000 for 2025, €5,000 per earlier year, +€1,000 for MBTiles, €6,000/yr for a
hosted endpoint; regional GeoTIFF extracts "starting at €1,500". The full
world comes as one file (856 GB for 2025 in Web Mercator); there are no
regional cuts of the ready-made tiles.

Printing: "Any static screenshot, video export, or printed output generated by
users that contains EOxCloudless imagery must have the attribution visibly
embedded directly on the media." In the app, a tap-to-open credit is fine on
small screens.

Bulk offline packs straight from EOX's free server would be many requests at
once, which their fair-use note asks us to avoid. For whole-fire packs, copy
the 2016 tiles we need to our own storage (CC BY allows it, and EOX suggests
"your own CDN"), or go straight to the Copernicus option below.

## Copernicus Sentinel-2 quarterly mosaics (recommended)

Copernicus (EU) publishes cloud-free Sentinel-2 mosaics every three months.
The STAC collection
[`sentinel-2-global-mosaics`](https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-global-mosaics)
points its licence at the
[Legal notice on the use of Copernicus Sentinel Data](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice):

> users shall have a free, full and open access to Copernicus Sentinel Data
> and Service Information without any express or implied warranty

> EU law grants free access to Copernicus Sentinel Data and Service
> Information for the purpose of the following use in so far as it is lawful:
> (a) reproduction; (b) distribution; (c) communication to the public;
> (d) adaptation, modification and combination with other data and
> information; (e) any combination of points (a) to (d).

> Where the Copernicus Sentinel Data and Service Information have been adapted
> or modified, the user shall provide the following notice:
> 'Contains modified Copernicus Sentinel data [Year]'

The [Copernicus Data Space terms](https://dataspace.copernicus.eu/terms-and-conditions)
add that "Any other contents of the Copernicus Data Space Ecosystem portal are
intended for non-commercial use", so we use the mosaic files themselves, not
screenshots from the Copernicus Browser. Downloads are subject to the
portal's quotas (free account).

What it is: red, green, blue and near-infrared at 10 m, one value per pixel
per quarter. The newest file over BC (checked 2026-11-18) is
`Sentinel-2_mosaic_2026_Q3_…`, July 1 – September 30, 2026. Where a quarter
had no cloud-free view, the pixel is left empty, so a build may need to fill
gaps from the quarter before.

What it would take (a follow-up PR, after Nick's go):

- A build script: download the BC mosaic files, make true-colour tiles to z14,
  pack them as one PMTiles file. Rough size: about 0.6 million tiles, on the
  order of 10–20 GB for all of BC (EOX's 10 m JPEG tiles run ~26 KB each). A
  1,000,000 ha fire is about 6,500 tiles (roughly 130–200 MB).
- Somewhere to host it (the same question as the planned regional basemap
  packs), and "Save offline" taught to include satellite.
- A refresh each season (more often during a big fire year if wanted).
- The credit on screen and on every exported map:
  `Contains modified Copernicus Sentinel data 2026`.

The same licence covers individual Sentinel-2 passes (every few days, cloud
permitting). That opens a later wildfire feature: a recent clear image over an
active fire. Out of scope here.

## Paid providers (offline rules)

**MapTiler Cloud** ([terms](https://www.maptiler.com/terms/cloud/)):

> Results of requests can be stored in a temporary personal cache (browser
> cache, mobile app cache, etc.) for use by a single end-user only.

> Unless otherwise agreed in writing with MapTiler, it is prohibited to export
> map content for usage outside the Service.

> Unless otherwise agreed in writing with MapTiler, it is prohibited to batch
> or excessive bulk download of map tiles or otherwise use the Service beyond
> the limits of these Terms.

Prints: "for an internal purpose (e.g. company flyers) with a maximum size of
A4 at 300 DPI". So: online only for us.

**MapTiler On-prem** ([pricing](https://www.maptiler.com/data/pricing/)):
Free tier is non-commercial (2016 low-res satellite, 100 monthly users).
Standard is US$2,500/yr: "Satellite Medium-Res", "internal app only (no B2B or
B2C)", up to 500 monthly users, 50 prints a month for internal use. Custom
(quote): "Satellite High-Res" add-on, B2B/B2C, "Custom prints internal or
external". The BC low-res download is the 2016 imagery to z13. Ask MapTiler
what "Medium-Res" and "High-Res" mean over BC before paying.

**Mapbox** ([iOS offline guide](https://docs.mapbox.com/ios/maps/guides/offline/concepts/)):

> Our terms of service do not allow developers or end users to redistribute
> offline maps downloaded from Mapbox servers.

Offline data must come through the Mapbox Maps SDK's own downloads ("may not
be preloaded, bundled or otherwise redistributed"), capped at 750 tile packs.
That's their native SDK, not MapLibre in a web view. For prints:
"To print images generated from the Mapbox Studio print export option for any
use, contact us" ([print help](https://docs.mapbox.com/help/print/)). So:
online only for us.

**Esri developer / offline licensing:** see the Esri section. Offline means
Esri Content Packages in Esri's SDKs; "please contact Esri" for Location
Platform accounts.

## USGS / NAIP

[USGSImageryOnly](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer)
is US federal imagery (mostly NAIP, 0.6–1 m), credit "USDA, USGS The National
Map: Orthoimagery. Data refreshed June, 2024." USGS distributes NAIP as public
domain. It stops at the border, so it's no use in BC.

## What changes in the app when we switch (for the follow-up PR)

- `src/map/basemap.ts`: the `satellite` source's tile URL, `maxzoom` (14 for
  Sentinel-2) and `attribution`.
- `vite.config.ts`: the CacheFirst pattern (drop `server.arcgisonline.com`,
  add the new host).
- `src/lib/mappacks.ts`: add satellite tiles to "Save offline" (counted
  against the tile cap on the website).
- The send-area export (PR #13): offer satellite and print its credit.
- The layer picker: show the imagery year next to "Satellite".
