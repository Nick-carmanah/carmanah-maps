/**
 * Synthetic fixtures for the layer import/export tests. The structure follows
 * Avenza Maps' public help docs and the KML 2.2 spec (see docs/avenza-layers.md);
 * every name, value and coordinate here is invented. Never put real maps or
 * real Avenza exports in this repo.
 */

/** Avenza-style export: typed Schemas with picklists, Folder per layer,
 * SchemaData values, photos in images/, a custom icon in files/, gx:Track. */
export const AVENZA_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Schema id="schema0" name="schema0">
      <SimpleField name="Description" type="string"/>
      <SimpleField name="pdfmaps_photos" type="string">
        <displayName>Photos</displayName>
      </SimpleField>
    </Schema>
    <Schema id="schema1" name="schema1">
      <SimpleField name="Description" type="string"/>
      <SimpleField name="pdfmaps_photos" type="string">
        <displayName>Photos</displayName>
      </SimpleField>
      <SimpleField name="Status" type="string"/>
      <SimpleField name="Flushed" type="bool"/>
      <SimpleField name="Pressure kPa" type="double"/>
      <SimpleField name="Outlets" type="int"/>
    </Schema>
    <ExtendedData xmlns:avenza="http://www.avenza.com">
            <avenza:picklist schemaUrl="schema1" avenza:field="Status">
          <avenza:picklistvalue><![CDATA[OK]]></avenza:picklistvalue>
          <avenza:picklistvalue><![CDATA[Damaged]]></avenza:picklistvalue>
          <avenza:picklistvalue><![CDATA[Missing]]></avenza:picklistvalue>
      </avenza:picklist>
            <avenza:picklist schemaUrl="schema1" avenza:field="Outlets">
      </avenza:picklist>
    </ExtendedData>
    <Folder>
      <styleUrl>#style0</styleUrl>
      <name>Hydrant inspection</name>
      <ExtendedData>
        <SchemaData schemaUrl="#schema0"/>
      </ExtendedData>
      <Folder>
        <styleUrl>#style0</styleUrl>
        <name>Hydrants</name>
        <ExtendedData>
          <SchemaData schemaUrl="#schema1"/>
        </ExtendedData>
        <Placemark>
          <name>Placemark 1</name>
          <TimeStamp>
            <when>2026-07-21T11:15:47-07:00</when>
          </TimeStamp>
          <styleUrl>#style1</styleUrl>
          <ExtendedData>
            <SchemaData schemaUrl="#schema1">
              <SimpleData name="Description">Cap missing &amp; leaking</SimpleData>
              <SimpleData name="pdfmaps_photos"><![CDATA[<img src="images/Placemark 1.jpg" /><br />]]></SimpleData>
              <SimpleData name="Status">Damaged</SimpleData>
              <SimpleData name="Flushed">true</SimpleData>
              <SimpleData name="Pressure kPa">412.5</SimpleData>
              <SimpleData name="Outlets">2</SimpleData>
            </SchemaData>
          </ExtendedData>
          <Point>
            <coordinates>
              -123.3651,48.4284,12.5
            </coordinates>
          </Point>
        </Placemark>
        <Placemark>
          <name>Placemark 2</name>
          <TimeStamp>
            <when>2026-07-21T11:20:00-07:00</when>
          </TimeStamp>
          <styleUrl>#style2</styleUrl>
          <ExtendedData>
            <SchemaData schemaUrl="#schema1">
              <SimpleData name="pdfmaps_photos"><![CDATA[<img src="images/Placemark 2.jpg" /><br /><img src="images/Placemark 2 (1).jpg" /><br />]]></SimpleData>
              <SimpleData name="Status">OK</SimpleData>
              <SimpleData name="Flushed">false</SimpleData>
            </SchemaData>
          </ExtendedData>
          <Point>
            <coordinates>
              -123.3602,48.4301,9.1
            </coordinates>
          </Point>
        </Placemark>
        <Placemark>
          <name>Custom icon</name>
          <TimeStamp>
            <when>2026-07-21T11:25:00-07:00</when>
          </TimeStamp>
          <styleUrl>#style4</styleUrl>
          <Point>
            <coordinates>
              -123.3611,48.4311,0
            </coordinates>
          </Point>
        </Placemark>
      </Folder>
      <Placemark>
        <name>Track 1</name>
        <TimeStamp>
          <when>2026-07-21T10:11:03-07:00</when>
        </TimeStamp>
        <styleUrl>#style3</styleUrl>
        <gx:Track>
          <when>2026-07-21T10:11:04-07:00</when>
          <when>2026-07-21T10:11:11-07:00</when>
          <when>2026-07-21T10:11:19-07:00</when>
          <gx:coord>-123.3700 48.4200 20.5</gx:coord>
          <gx:coord>-123.3690 48.4210 21.0</gx:coord>
          <gx:coord>-123.3680 48.4222 21.7</gx:coord>
          <gx:angles>-1 -1 -1</gx:angles>
          <gx:angles>-1 -1 -1</gx:angles>
          <gx:angles>-1 -1 -1</gx:angles>
          <ExtendedData>
            <SchemaData schemaUrl="#track_schema">
              <gx:SimpleArrayData name="speed">
                <gx:value>0.3</gx:value>
                <gx:value>1.2</gx:value>
                <gx:value>1.1</gx:value>
              </gx:SimpleArrayData>
            </SchemaData>
          </ExtendedData>
        </gx:Track>
      </Placemark>
      <Placemark>
        <name>Area 1</name>
        <TimeStamp>
          <when>2026-07-21T12:00:00-07:00</when>
        </TimeStamp>
        <styleUrl>#style5</styleUrl>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>
                -123.37,48.42,0 -123.36,48.42,0 -123.36,48.43,0 -123.37,48.43,0 -123.37,48.42,0
              </coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </Placemark>
    </Folder>
    <Style id="style0">
      <IconStyle>
        <color>802f80ff</color>
        <Icon>
          <href>http://download.avenza.com/images/pdfmaps_icons/red_pin.png</href>
        </Icon>
        <hotSpot x="0.5" xunits="fraction" y="0.5" yunits="fraction"/>
      </IconStyle>
      <LineStyle>
        <color>ff2f80ff</color>
        <width>4</width>
      </LineStyle>
      <PolyStyle>
        <color>802f80ff</color>
      </PolyStyle>
    </Style>
    <Style id="style1">
      <IconStyle>
        <Icon>
          <href>http://download.avenza.com/images/pdfmaps_icons/red_pin.png</href>
        </Icon>
        <hotSpot x="0.5" xunits="fraction" y="0.5" yunits="fraction"/>
      </IconStyle>
    </Style>
    <Style id="style2">
      <IconStyle>
        <Icon>
          <href>http://download.avenza.com/images/pdfmaps_icons/yellow_pin.png</href>
        </Icon>
        <hotSpot x="0.5" xunits="fraction" y="0.5" yunits="fraction"/>
      </IconStyle>
    </Style>
    <Style id="style3">
      <LineStyle>
        <color>ff2e80ff</color>
        <width>4</width>
      </LineStyle>
      <PolyStyle>
        <color>7f2e80ff</color>
      </PolyStyle>
    </Style>
    <Style id="style4">
      <IconStyle>
        <Icon>
          <href>files/hydrant%20icon.png</href>
        </Icon>
      </IconStyle>
    </Style>
    <Style id="style5">
      <LineStyle>
        <color>ff0000ff</color>
        <width>2</width>
      </LineStyle>
      <PolyStyle>
        <color>4d0000ff</color>
      </PolyStyle>
    </Style>
    <Schema id="track_schema" name="track_schema">
      <gx:SimpleArrayField name="speed" type="float">
        <displayName>speed</displayName>
      </gx:SimpleArrayField>
    </Schema>
  </Document>
</kml>
`

/** Google Earth / My Maps flavour: loose placemarks, StyleMap, <Data>,
 * HTML description with an image, MultiGeometry, a polygon with a hole. */
export const GOOGLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>Field notes</name>
  <StyleMap id="m_pin"><Pair><key>normal</key><styleUrl>#s_pin</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#s_pin_hl</styleUrl></Pair></StyleMap>
  <Style id="s_pin"><IconStyle><color>ff00ffff</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/wht-pushpin.png</href></Icon></IconStyle></Style>
  <Style id="s_pin_hl"><IconStyle><scale>1.3</scale></IconStyle></Style>
  <Style id="s_poly"><LineStyle><color>ff00ff00</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
  <Placemark>
    <name>Spot fire</name>
    <description><![CDATA[<b>Smoke</b> seen at 14:05<br/>Crew notified<br/><img src="files/smoke.jpg" width="300"/>]]></description>
    <styleUrl>#m_pin</styleUrl>
    <ExtendedData>
      <Data name="Reported by"><value>Crew 2</value></Data>
      <Data name="Size ha"><value>0.1</value></Data>
    </ExtendedData>
    <Point><coordinates>-123.30, 48.45</coordinates></Point>
  </Placemark>
  <Placemark>
    <name>Island</name>
    <styleUrl>#s_poly</styleUrl>
    <Polygon>
      <outerBoundaryIs><LinearRing><coordinates>-123.40,48.40 -123.30,48.40 -123.30,48.50 -123.40,48.50 -123.40,48.40</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>-123.36,48.44 -123.34,48.44 -123.34,48.46 -123.36,48.46 -123.36,48.44</coordinates></LinearRing></innerBoundaryIs>
    </Polygon>
  </Placemark>
  <Placemark>
    <name>Combo</name>
    <MultiGeometry>
      <Point><coordinates>-123.31,48.41,0</coordinates></Point>
      <LineString><coordinates>-123.31,48.41,0 -123.32,48.42,0</coordinates></LineString>
    </MultiGeometry>
  </Placemark>
  <Placemark><name>No geometry</name></Placemark>
  <GroundOverlay><name>Scan</name></GroundOverlay>
</Document>
</kml>
`

export const CSV_VARIANTS: { name: string; text: string; expect: [number, number][] }[] = [
  {
    name: 'semicolon-comma-decimal.csv',
    text: 'Nom;Lat;Lon;Remarks\r\nA;48,4284;-123,3651;one\r\nB;48,43;-123,36;"two; quoted"\r\n',
    expect: [[-123.3651, 48.4284], [-123.36, 48.43]],
  },
  {
    name: 'dms.csv',
    text: 'name,latitude,longitude\nDMS,"48°25\'42.2""N","123°21\'54.4""W"\n',
    expect: [[-(123 + 21 / 60 + 54.4 / 3600), 48 + 25 / 60 + 42.2 / 3600]],
  },
  {
    name: 'wkt.csv',
    text: 'id,WKT,kind\n1,POINT (-123.1 48.2),x\n',
    expect: [[-123.1, 48.2]],
  },
  {
    name: 'swapped.csv',
    text: 'name,lat,lon\nS,-123.5,48.5\n',
    expect: [[-123.5, 48.5]],
  },
  {
    name: 'xy.csv',
    text: '\uFEFFName\tX\tY\tCount\nP\t-120.5\t50.25\t7\n',
    expect: [[-120.5, 50.25]],
  },
]

/** Small fake image bytes with the right magic number; `seed` makes them distinct. */
export function fakeImage(type: 'jpeg' | 'png', seed: string): Blob {
  const magic =
    type === 'jpeg' ? [0xff, 0xd8, 0xff, 0xe0] : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const rest = Array.from(new TextEncoder().encode(seed))
  return new Blob([new Uint8Array([...magic, ...rest, 0, 1, 2, 254, 255])], { type: `image/${type}` })
}

export const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

/** Minimal point shapefile (.shp/.shx/.dbf/.prj) writer, WGS 84. */
type ShpField = { name: string; type: 'C' | 'N'; len: number; dec?: number }

export function pointShapefile(points: { x: number; y: number; attrs: (string | number)[] }[], fields: ShpField[]) {
  const n = points.length
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const header = (lengthWords: number) => {
    const b = new DataView(new ArrayBuffer(100))
    b.setInt32(0, 9994)
    b.setInt32(24, lengthWords)
    b.setInt32(28, 1000, true)
    b.setInt32(32, 1, true)
    b.setFloat64(36, Math.min(...xs), true)
    b.setFloat64(44, Math.min(...ys), true)
    b.setFloat64(52, Math.max(...xs), true)
    b.setFloat64(60, Math.max(...ys), true)
    return new Uint8Array(b.buffer)
  }
  const shp = new Uint8Array(100 + n * 28)
  shp.set(header((100 + n * 28) / 2))
  const shx = new Uint8Array(100 + n * 8)
  shx.set(header((100 + n * 8) / 2))
  const sv = new DataView(shp.buffer)
  const xv = new DataView(shx.buffer)
  points.forEach((p, i) => {
    const off = 100 + i * 28
    sv.setInt32(off, i + 1)
    sv.setInt32(off + 4, 10)
    sv.setInt32(off + 8, 1, true)
    sv.setFloat64(off + 12, p.x, true)
    sv.setFloat64(off + 20, p.y, true)
    xv.setInt32(100 + i * 8, off / 2)
    xv.setInt32(100 + i * 8 + 4, 10)
  })
  const recLen = 1 + fields.reduce((s, f) => s + f.len, 0)
  const headLen = 32 + 32 * fields.length + 1
  const dbf = new Uint8Array(headLen + n * recLen + 1)
  const dv = new DataView(dbf.buffer)
  dbf[0] = 3
  dbf[1] = 126
  dbf[2] = 11
  dbf[3] = 18
  dv.setUint32(4, n, true)
  dv.setUint16(8, headLen, true)
  dv.setUint16(10, recLen, true)
  const enc = new TextEncoder()
  fields.forEach((f, i) => {
    const o = 32 + i * 32
    dbf.set(enc.encode(f.name.slice(0, 10)), o)
    dbf[o + 11] = f.type.charCodeAt(0)
    dbf[o + 16] = f.len
    dbf[o + 17] = f.dec ?? 0
  })
  dbf[headLen - 1] = 0x0d
  points.forEach((p, r) => {
    let o = headLen + r * recLen
    dbf[o++] = 0x20
    fields.forEach((f, i) => {
      const v = p.attrs[i]
      const text = f.type === 'N' ? (typeof v === 'number' ? v.toFixed(f.dec ?? 0) : String(v)).padStart(f.len) : String(v).padEnd(f.len)
      dbf.set(enc.encode(text.slice(0, f.len)), o)
      o += f.len
    })
  })
  dbf[dbf.length - 1] = 0x1a
  const prj = enc.encode(
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]',
  )
  return { shp, shx, dbf, prj }
}
