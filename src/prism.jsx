import { useState, useReducer, useCallback, useMemo, useRef, useEffect, createContext, useContext } from "react";
import
{
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts";
import * as Papa from "papaparse";

// -- Utility functions (pure, no side effects) --

const identity = ( x ) => x;

const pipe = ( ...fns ) => ( x ) => fns.reduce( ( v, f ) => f( v ), x );

const deepClone = ( obj ) => JSON.parse( JSON.stringify( obj ) );

const inferType = ( values ) =>
{
  const nonEmpty = values.filter( ( v ) => v !== null && v !== undefined && v !== "" );
  if ( nonEmpty.length === 0 ) return "string";
  const allNumbers = nonEmpty.every( ( v ) => !isNaN( Number( v ) ) && v !== "" );
  if ( allNumbers ) return "number";
  const datePattern = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
  const allDates = nonEmpty.every( ( v ) => datePattern.test( String( v ) ) );
  if ( allDates ) return "date";
  return "string";
};

const computeStats = ( values, type ) =>
{
  if ( type === "number" )
  {
    const nums = values.filter( ( v ) => v !== null && v !== undefined && v !== "" ).map( Number );
    if ( nums.length === 0 ) return { min: 0, max: 0, mean: 0, count: 0 };
    const min = Math.min( ...nums );
    const max = Math.max( ...nums );
    const mean = nums.reduce( ( a, b ) => a + b, 0 ) / nums.length;
    return { min, max, mean: Math.round( mean * 100 ) / 100, count: nums.length };
  }
  if ( type === "date" )
  {
    const dates = values.filter( ( v ) => v ).map( ( v ) => new Date( v ) );
    const valid = dates.filter( ( d ) => !isNaN( d.getTime() ) );
    if ( valid.length === 0 ) return { earliest: "N/A", latest: "N/A", count: 0 };
    valid.sort( ( a, b ) => a - b );
    return {
      earliest: valid[ 0 ].toISOString().split( "T" )[ 0 ],
      latest: valid[ valid.length - 1 ].toISOString().split( "T" )[ 0 ],
      count: valid.length,
    };
  }
  const unique = new Set( values.filter( ( v ) => v !== null && v !== undefined && v !== "" ) );
  return { uniqueCount: unique.size, count: values.length };
};

const coerceRow = ( row, columnTypes ) =>
{
  const result = {};
  for ( const [ col, type ] of Object.entries( columnTypes ) )
  {
    const val = row[ col ];
    if ( type === "number" )
    {
      result[ col ] = val === "" || val === null || val === undefined ? null : Number( val );
    } else
    {
      result[ col ] = val === undefined ? null : val;
    }
  }
  return result;
};

// -- Engine abstraction --
// shows how the same logical operation maps to different physical implementations.
// Actual execution stays in JS. Arrow and WebGPU show conceptual operator mappings.

const ENGINES = {
  js: { name: "JavaScript (Array)", description: "Standard Array methods: map, filter, reduce, sort" },
  arrow: { name: "Apache Arrow (columnar, conceptual)", description: "Arrow is a columnar memory format, not a query engine, so it has no planner. Shows how each step maps to Arrow-style columnar operations; execution stays in JS." },
  webgpu: { name: "WebGPU (Compute Shaders)", description: "Parallel compute on GPU. Data as GPU buffers, transforms as shader dispatches." },
  duckdb: { name: "DuckDB (WASM)", description: "Full SQL engine compiled to WebAssembly. Real query execution with EXPLAIN plans." },
};

const ENGINE_OPS = {
  filter: {
    js: "Array.filter(predicate)",
    arrow: "RecordBatch.filter(predicateVector) -> filtered RecordBatch",
    webgpu: "compactKernel(predicateBuffer, dataBuffer) -> stream compaction",
    duckdb: "WHERE column op value",
  },
  sort: {
    js: "[...data].sort(comparator)",
    arrow: "Table.orderBy(columnIndex, direction) -> sorted Table",
    webgpu: "bitonicSortKernel(keyBuffer, indexBuffer) -> sorted indices",
    duckdb: "ORDER BY column [ASC|DESC]",
  },
  group_aggregate: {
    js: "reduce into groups Map, then map groups to aggregates",
    arrow: "HashAggregate(groupKeys, aggExprs) -> grouped RecordBatch",
    webgpu: "hashPartitionKernel + parallelReduceKernel per partition",
    duckdb: "GROUP BY cols + SUM/AVG/COUNT/MIN/MAX/MEDIAN",
  },
  compute: {
    js: "data.map(row => ({...row, newCol: expr(row)}))",
    arrow: "compute(expression, inputArrays) -> new ChunkedArray, append to Table",
    webgpu: "elementWiseKernel(inputBuffers) -> outputBuffer",
    duckdb: "SELECT *, (expr) AS new_column",
  },
  rename: {
    js: "data.map(destructure and rename)",
    arrow: "Table.renameColumn(oldIdx, newName) -> new Schema, zero-copy",
    webgpu: "metadata-only: update column name in descriptor, no kernel dispatch",
    duckdb: "SELECT * EXCLUDE (old) , old AS new_name",
  },
  drop: {
    js: "data.map(omit dropped keys)",
    arrow: "Table.selectColumns(keepIndices) -> projected Table, zero-copy",
    webgpu: "metadata-only: remove buffer binding, no kernel dispatch",
    duckdb: "SELECT * EXCLUDE (col1, col2)",
  },
  top_n: {
    js: "[...data].sort(cmp).slice(0, n)",
    arrow: "partialSort(column, n, direction) -> truncated Table",
    webgpu: "topKKernel(keyBuffer, k) via parallel partial sort",
    duckdb: "ORDER BY column [ASC|DESC] LIMIT n",
  },
  pivot: {
    js: "group + reshape into wide format object",
    arrow: "pivot_wider(Table, rowKey, pivotKey, valueKey) -> wide RecordBatch",
    webgpu: "scatterKernel(rowIndices, colIndices, values) -> 2D output buffer",
    duckdb: "PIVOT table ON pivot_col USING agg(val) GROUP BY row_col",
  },
  unpivot: {
    js: "flatMap rows, one entry per non-id column",
    arrow: "pivot_longer(Table, idCols) -> tall RecordBatch",
    webgpu: "gatherKernel(idBuffers, valueBuffers) -> expanded output buffer",
    duckdb: "UNPIVOT table ON COLUMNS(*) INTO NAME var VALUE val",
  },
  join: {
    js: "nested loop or hash join: build index on right, probe with left",
    arrow: "HashJoin(leftTable, rightTable, keys, type) -> joined RecordBatch",
    webgpu: "hashBuildKernel(rightKeys) + hashProbeKernel(leftKeys) -> join indices",
    duckdb: "[INNER|LEFT|RIGHT] JOIN right ON condition",
  },
  union: {
    js: "[...left, ...right] with schema alignment",
    arrow: "Table.concat(leftTable, rightTable) -> combined Table",
    webgpu: "copyKernel(leftBuffers, rightBuffers) -> concatenated buffers",
    duckdb: "UNION ALL",
  },
  distinct: {
    js: "filter with Set for seen keys",
    arrow: "HashDistinct(columns) -> deduplicated RecordBatch",
    webgpu: "hashDeduplicateKernel(keyBuffers) -> unique indices",
    duckdb: "SELECT DISTINCT [ON (cols)]",
  },
  fill_null: {
    js: "data.map(row => row[col] ?? fillValue)",
    arrow: "ifElse(isNull(column), scalar(fill), column) -> patched Array",
    webgpu: "conditionalFillKernel(nullMask, fillValue) -> patched buffer",
    duckdb: "COALESCE(column, fill_value)",
  },
  sample: {
    js: "Fisher-Yates shuffle, take first n",
    arrow: "take(Table, randomIndices(n)) -> sampled Table",
    webgpu: "randomIndexKernel(seed, n) + gatherKernel -> sampled buffers",
    duckdb: "USING SAMPLE n ROWS",
  },
  window: {
    js: "sort + sliding reduce over window frame",
    arrow: "WindowExec(partitionKeys, orderKey, frameSpec, aggExpr) -> new column",
    webgpu: "prefixSumKernel or slidingReduceKernel per partition segment",
    duckdb: "fn() OVER (ORDER BY col ROWS UNBOUNDED PRECEDING)",
  },
  cast_type: {
    js: "data.map(row => ({...row, [col]: castFn(row[col])}))",
    arrow: "cast(column, targetType) -> new Array with target type",
    webgpu: "castKernel(inputBuffer, srcType, dstType) -> converted buffer",
    duckdb: "CAST(column AS target_type)",
  },
};

// -- Sample datasets --

const SAMPLE_DATASETS = {
  population: {
    name: "World Population by Country",
    description: "Population data for selected countries across decades",
    files: {
      main: {
        name: "population.csv",
        "data": [
          { "country": "China", "continent": "Asia", "year": 2000, "population": 1262645, "gdp_per_capita": 959 },
          { "country": "China", "continent": "Asia", "year": 2010, "population": 1337705, "gdp_per_capita": 4550 },
          { "country": "China", "continent": "Asia", "year": 2020, "population": 1402112, "gdp_per_capita": 10500 },
          { "country": "India", "continent": "Asia", "year": 2000, "population": 1056576, "gdp_per_capita": 443 },
          { "country": "India", "continent": "Asia", "year": 2010, "population": 1234281, "gdp_per_capita": 1358 },
          { "country": "India", "continent": "Asia", "year": 2020, "population": 1380004, "gdp_per_capita": 1901 },
          { "country": "United States", "continent": "North America", "year": 2000, "population": 282162, "gdp_per_capita": 36330 },
          { "country": "United States", "continent": "North America", "year": 2010, "population": 309327, "gdp_per_capita": 48468 },
          { "country": "United States", "continent": "North America", "year": 2020, "population": 331003, "gdp_per_capita": 63544 },
          { "country": "Brazil", "continent": "South America", "year": 2000, "population": 174504, "gdp_per_capita": 3695 },
          { "country": "Brazil", "continent": "South America", "year": 2010, "population": 195714, "gdp_per_capita": 11122 },
          { "country": "Brazil", "continent": "South America", "year": 2020, "population": 212559, "gdp_per_capita": 6797 },
          { "country": "Nigeria", "continent": "Africa", "year": 2000, "population": 122284, "gdp_per_capita": 568 },
          { "country": "Nigeria", "continent": "Africa", "year": 2010, "population": 158259, "gdp_per_capita": 2292 },
          { "country": "Nigeria", "continent": "Africa", "year": 2020, "population": 206140, "gdp_per_capita": 2097 },
          { "country": "Germany", "continent": "Europe", "year": 2000, "population": 82212, "gdp_per_capita": 23719 },
          { "country": "Germany", "continent": "Europe", "year": 2010, "population": 81777, "gdp_per_capita": 41786 },
          { "country": "Germany", "continent": "Europe", "year": 2020, "population": 83784, "gdp_per_capita": 46208 },
          { "country": "Japan", "continent": "Asia", "year": 2000, "population": 126926, "gdp_per_capita": 38532 },
          { "country": "Japan", "continent": "Asia", "year": 2010, "population": 128057, "gdp_per_capita": 44508 },
          { "country": "Japan", "continent": "Asia", "year": 2020, "population": 126476, "gdp_per_capita": 40146 },
          { "country": "Indonesia", "continent": "Asia", "year": 2000, "population": 211540, "gdp_per_capita": 780 },
          { "country": "Indonesia", "continent": "Asia", "year": 2010, "population": 241834, "gdp_per_capita": 3122 },
          { "country": "Indonesia", "continent": "Asia", "year": 2020, "population": 273524, "gdp_per_capita": 3870 },
          { "country": "France", "continent": "Europe", "year": 2002, "population": 59925, "gdp_per_capita": 28926 },
          { "country": "France", "continent": "Europe", "year": 2007, "population": 61084, "gdp_per_capita": 30470 },
          { "country": "United Kingdom", "continent": "Europe", "year": 2002, "population": 59912, "gdp_per_capita": 29479 },
          { "country": "United Kingdom", "continent": "Europe", "year": 2007, "population": 60776, "gdp_per_capita": 33203 },
          { "country": "Canada", "continent": "North America", "year": 2002, "population": 31902, "gdp_per_capita": 33329 },
          { "country": "Canada", "continent": "North America", "year": 2007, "population": 33390, "gdp_per_capita": 36319 },
          { "country": "Australia", "continent": "Oceania", "year": 2002, "population": 19547, "gdp_per_capita": 30688 },
          { "country": "Australia", "continent": "Oceania", "year": 2007, "population": 20434, "gdp_per_capita": 34435 },
          { "country": "Mexico", "continent": "North America", "year": 2002, "population": 102480, "gdp_per_capita": 10742 },
          { "country": "Mexico", "continent": "North America", "year": 2007, "population": 108701, "gdp_per_capita": 11978 },
          { "country": "Argentina", "continent": "South America", "year": 2002, "population": 38331, "gdp_per_capita": 8798 },
          { "country": "Argentina", "continent": "South America", "year": 2007, "population": 40302, "gdp_per_capita": 12779 },
          { "country": "Chile", "continent": "South America", "year": 2002, "population": 15497, "gdp_per_capita": 10779 },
          { "country": "Chile", "continent": "South America", "year": 2007, "population": 16285, "gdp_per_capita": 13172 },
          { "country": "Colombia", "continent": "South America", "year": 2002, "population": 41008, "gdp_per_capita": 5755 },
          { "country": "Colombia", "continent": "South America", "year": 2007, "population": 44228, "gdp_per_capita": 7007 },
          { "country": "Peru", "continent": "South America", "year": 2002, "population": 26769, "gdp_per_capita": 5909 },
          { "country": "Peru", "continent": "South America", "year": 2007, "population": 28675, "gdp_per_capita": 7409 },
          { "country": "Venezuela", "continent": "South America", "year": 2002, "population": 24288, "gdp_per_capita": 8605 },
          { "country": "Venezuela", "continent": "South America", "year": 2007, "population": 26085, "gdp_per_capita": 11416 },
          { "country": "South Africa", "continent": "Africa", "year": 2002, "population": 44434, "gdp_per_capita": 7711 },
          { "country": "South Africa", "continent": "Africa", "year": 2007, "population": 43998, "gdp_per_capita": 9270 },
          { "country": "Egypt", "continent": "Africa", "year": 2002, "population": 73313, "gdp_per_capita": 4755 },
          { "country": "Egypt", "continent": "Africa", "year": 2007, "population": 80265, "gdp_per_capita": 5581 },
          { "country": "Kenya", "continent": "Africa", "year": 2002, "population": 31387, "gdp_per_capita": 1288 },
          { "country": "Kenya", "continent": "Africa", "year": 2007, "population": 35610, "gdp_per_capita": 1463 },
          { "country": "Ethiopia", "continent": "Africa", "year": 2002, "population": 67947, "gdp_per_capita": 530 },
          { "country": "Ethiopia", "continent": "Africa", "year": 2007, "population": 76512, "gdp_per_capita": 691 },
          { "country": "Ghana", "continent": "Africa", "year": 2002, "population": 20551, "gdp_per_capita": 1112 },
          { "country": "Ghana", "continent": "Africa", "year": 2007, "population": 22873, "gdp_per_capita": 1328 },
          { "country": "Morocco", "continent": "Africa", "year": 2002, "population": 31168, "gdp_per_capita": 3258 },
          { "country": "Morocco", "continent": "Africa", "year": 2007, "population": 33757, "gdp_per_capita": 3820 },
          { "country": "Pakistan", "continent": "Asia", "year": 2002, "population": 153404, "gdp_per_capita": 2093 },
          { "country": "Pakistan", "continent": "Asia", "year": 2007, "population": 169271, "gdp_per_capita": 2606 },
          { "country": "Bangladesh", "continent": "Asia", "year": 2002, "population": 135657, "gdp_per_capita": 1136 },
          { "country": "Bangladesh", "continent": "Asia", "year": 2007, "population": 150448, "gdp_per_capita": 1391 },
          { "country": "Vietnam", "continent": "Asia", "year": 2002, "population": 80908, "gdp_per_capita": 1764 },
          { "country": "Vietnam", "continent": "Asia", "year": 2007, "population": 85262, "gdp_per_capita": 2442 },
          { "country": "Thailand", "continent": "Asia", "year": 2002, "population": 62807, "gdp_per_capita": 5913 },
          { "country": "Thailand", "continent": "Asia", "year": 2007, "population": 65068, "gdp_per_capita": 7458 },
          { "country": "Philippines", "continent": "Asia", "year": 2002, "population": 82995, "gdp_per_capita": 2651 },
          { "country": "Philippines", "continent": "Asia", "year": 2007, "population": 91077, "gdp_per_capita": 3190 },
          { "country": "Malaysia", "continent": "Asia", "year": 2002, "population": 22662, "gdp_per_capita": 10207 },
          { "country": "Malaysia", "continent": "Asia", "year": 2007, "population": 24821, "gdp_per_capita": 12452 },
          { "country": "Turkey", "continent": "Europe", "year": 2002, "population": 67309, "gdp_per_capita": 6508 },
          { "country": "Turkey", "continent": "Europe", "year": 2007, "population": 71159, "gdp_per_capita": 8458 },
          { "country": "Spain", "continent": "Europe", "year": 2002, "population": 40153, "gdp_per_capita": 24835 },
          { "country": "Spain", "continent": "Europe", "year": 2007, "population": 40448, "gdp_per_capita": 28821 },
          { "country": "Italy", "continent": "Europe", "year": 2002, "population": 57927, "gdp_per_capita": 27968 },
          { "country": "Italy", "continent": "Europe", "year": 2007, "population": 58148, "gdp_per_capita": 28570 }
        ],
      },
    },
  },
  temperature: {
    name: "Global Temperature Anomalies",
    description: "Annual temperature anomaly relative to 1951-1980 baseline",
    files: {
      main: {
        name: "temperature.csv",
        data: ( () =>
        {
          const base = [
            [ 1960, -0.01 ], [ 1962, 0.09 ], [ 1964, -0.2 ], [ 1966, -0.02 ], [ 1968, -0.07 ],
            [ 1970, 0.04 ], [ 1972, 0.01 ], [ 1974, -0.07 ], [ 1976, -0.1 ], [ 1978, 0.07 ],
            [ 1980, 0.26 ], [ 1982, 0.13 ], [ 1984, 0.15 ], [ 1986, 0.18 ], [ 1988, 0.38 ],
            [ 1990, 0.45 ], [ 1992, 0.22 ], [ 1994, 0.31 ], [ 1996, 0.33 ], [ 1998, 0.63 ],
            [ 2000, 0.39 ], [ 2002, 0.63 ], [ 2004, 0.54 ], [ 2006, 0.62 ], [ 2008, 0.54 ],
            [ 2010, 0.72 ], [ 2012, 0.64 ], [ 2014, 0.75 ], [ 2016, 1.01 ], [ 2018, 0.85 ],
            [ 2020, 1.02 ], [ 2022, 0.89 ],
          ];
          return base.map( ( [ year, anomaly ] ) => ( {
            year,
            anomaly_c: anomaly,
            anomaly_f: Math.round( anomaly * 1.8 * 100 ) / 100,
            decade: `${ Math.floor( year / 10 ) * 10 }s`,
            direction: anomaly >= 0 ? "warming" : "cooling",
          } ) );
        } )(),
      },
    },
  },
  movies: {
    name: "Movie Ratings and Revenue",
    description: "Box office data for selected films across genres",
    files: {
      main: {
        name: "movies.csv",
        "data": [
          { "title": "The Dark Knight", "genre": "Action", "year": 2008, "rating": 9.0, "budget": 185, "revenue": 1005, "studio": "Warner Bros" },
          { "title": "Inception", "genre": "Sci-Fi", "year": 2010, "rating": 8.8, "budget": 160, "revenue": 836, "studio": "Warner Bros" },
          { "title": "Interstellar", "genre": "Sci-Fi", "year": 2014, "rating": 8.7, "budget": 165, "revenue": 701, "studio": "Paramount" },
          { "title": "The Avengers", "genre": "Action", "year": 2012, "rating": 8.0, "budget": 220, "revenue": 1519, "studio": "Disney" },
          { "title": "Frozen", "genre": "Animation", "year": 2013, "rating": 7.4, "budget": 150, "revenue": 1274, "studio": "Disney" },
          { "title": "Joker", "genre": "Drama", "year": 2019, "rating": 8.4, "budget": 55, "revenue": 1074, "studio": "Warner Bros" },
          { "title": "Parasite", "genre": "Drama", "year": 2019, "rating": 8.5, "budget": 11, "revenue": 258, "studio": "CJ Entertainment" },
          { "title": "Get Out", "genre": "Horror", "year": 2017, "rating": 7.7, "budget": 5, "revenue": 255, "studio": "Universal" },
          { "title": "Mad Max: Fury Road", "genre": "Action", "year": 2015, "rating": 8.1, "budget": 150, "revenue": 375, "studio": "Warner Bros" },
          { "title": "Inside Out", "genre": "Animation", "year": 2015, "rating": 8.1, "budget": 175, "revenue": 857, "studio": "Disney" },
          { "title": "Arrival", "genre": "Sci-Fi", "year": 2016, "rating": 7.9, "budget": 47, "revenue": 203, "studio": "Paramount" },
          { "title": "Coco", "genre": "Animation", "year": 2017, "rating": 8.4, "budget": 175, "revenue": 807, "studio": "Disney" },
          { "title": "Blade Runner 2049", "genre": "Sci-Fi", "year": 2017, "rating": 8.0, "budget": 150, "revenue": 259, "studio": "Warner Bros" },
          { "title": "A Quiet Place", "genre": "Horror", "year": 2018, "rating": 7.5, "budget": 17, "revenue": 340, "studio": "Paramount" },
          { "title": "Spider-Man: Into the Spider-Verse", "genre": "Animation", "year": 2018, "rating": 8.4, "budget": 90, "revenue": 375, "studio": "Sony" },
          { "title": "Knives Out", "genre": "Drama", "year": 2019, "rating": 7.9, "budget": 40, "revenue": 312, "studio": "Lionsgate" },
          { "title": "Dune", "genre": "Sci-Fi", "year": 2021, "rating": 8.0, "budget": 165, "revenue": 401, "studio": "Warner Bros" },
          { "title": "Everything Everywhere", "genre": "Action", "year": 2022, "rating": 7.8, "budget": 25, "revenue": 141, "studio": "A24" },
          { "title": "The Batman", "genre": "Action", "year": 2022, "rating": 7.8, "budget": 185, "revenue": 771, "studio": "Warner Bros" },
          { "title": "Oppenheimer", "genre": "Drama", "year": 2023, "rating": 8.3, "budget": 100, "revenue": 952, "studio": "Universal" },
          { "title": "The Shawshank Redemption", "genre": "Drama", "year": 1994, "rating": 9.3, "budget": 25, "revenue": 29, "studio": "Columbia Pictures" },
          { "title": "The Godfather", "genre": "Drama", "year": 1972, "rating": 9.2, "budget": 6, "revenue": 250, "studio": "Paramount" },
          { "title": "Pulp Fiction", "genre": "Drama", "year": 1994, "rating": 8.9, "budget": 8, "revenue": 214, "studio": "Miramax" },
          { "title": "Fight Club", "genre": "Drama", "year": 1999, "rating": 8.8, "budget": 63, "revenue": 101, "studio": "20th Century Fox" },
          { "title": "The Matrix", "genre": "Sci-Fi", "year": 1999, "rating": 8.7, "budget": 63, "revenue": 467, "studio": "Warner Bros" },
          { "title": "Gladiator", "genre": "Action", "year": 2000, "rating": 8.5, "budget": 103, "revenue": 465, "studio": "DreamWorks" },
          { "title": "The Lord of the Rings: The Fellowship of the Ring", "genre": "Fantasy", "year": 2001, "rating": 8.9, "budget": 93, "revenue": 898, "studio": "New Line Cinema" },
          { "title": "The Lord of the Rings: The Two Towers", "genre": "Fantasy", "year": 2002, "rating": 8.8, "budget": 94, "revenue": 947, "studio": "New Line Cinema" },
          { "title": "The Lord of the Rings: The Return of the King", "genre": "Fantasy", "year": 2003, "rating": 9.0, "budget": 94, "revenue": 1146, "studio": "New Line Cinema" },
          { "title": "Harry Potter and the Sorcerer's Stone", "genre": "Fantasy", "year": 2001, "rating": 7.7, "budget": 125, "revenue": 1024, "studio": "Warner Bros" },
          { "title": "Harry Potter and the Prisoner of Azkaban", "genre": "Fantasy", "year": 2004, "rating": 7.9, "budget": 130, "revenue": 797, "studio": "Warner Bros" },
          { "title": "Harry Potter and the Deathly Hallows: Part 2", "genre": "Fantasy", "year": 2011, "rating": 8.1, "budget": 125, "revenue": 1342, "studio": "Warner Bros" },
          { "title": "Pirates of the Caribbean: The Curse of the Black Pearl", "genre": "Action", "year": 2003, "rating": 8.1, "budget": 140, "revenue": 654, "studio": "Disney" },
          { "title": "Avatar", "genre": "Sci-Fi", "year": 2009, "rating": 7.9, "budget": 237, "revenue": 2924, "studio": "20th Century Fox" },
          { "title": "Titanic", "genre": "Drama", "year": 1997, "rating": 7.9, "budget": 200, "revenue": 2258, "studio": "Paramount" },
          { "title": "Jurassic Park", "genre": "Sci-Fi", "year": 1993, "rating": 8.2, "budget": 63, "revenue": 1109, "studio": "Universal" },
          { "title": "Jaws", "genre": "Horror", "year": 1975, "rating": 8.1, "budget": 9, "revenue": 476, "studio": "Universal" },
          { "title": "E.T. the Extra-Terrestrial", "genre": "Sci-Fi", "year": 1982, "rating": 7.9, "budget": 11, "revenue": 797, "studio": "Universal" },
          { "title": "Star Wars: A New Hope", "genre": "Sci-Fi", "year": 1977, "rating": 8.6, "budget": 11, "revenue": 775, "studio": "20th Century Fox" },
          { "title": "Star Wars: The Empire Strikes Back", "genre": "Sci-Fi", "year": 1980, "rating": 8.7, "budget": 18, "revenue": 538, "studio": "20th Century Fox" },
          { "title": "Star Wars: The Force Awakens", "genre": "Sci-Fi", "year": 2015, "rating": 7.8, "budget": 245, "revenue": 2068, "studio": "Disney" },
          { "title": "Rogue One: A Star Wars Story", "genre": "Sci-Fi", "year": 2016, "rating": 7.8, "budget": 200, "revenue": 1059, "studio": "Disney" },
          { "title": "Guardians of the Galaxy", "genre": "Action", "year": 2014, "rating": 8.0, "budget": 170, "revenue": 773, "studio": "Disney" },
          { "title": "Black Panther", "genre": "Action", "year": 2018, "rating": 7.3, "budget": 200, "revenue": 1348, "studio": "Disney" },
          { "title": "Avengers: Infinity War", "genre": "Action", "year": 2018, "rating": 8.4, "budget": 316, "revenue": 2048, "studio": "Disney" },
          { "title": "Avengers: Endgame", "genre": "Action", "year": 2019, "rating": 8.4, "budget": 356, "revenue": 2798, "studio": "Disney" },
          { "title": "Iron Man", "genre": "Action", "year": 2008, "rating": 7.9, "budget": 140, "revenue": 585, "studio": "Paramount" },
          { "title": "Captain America: Civil War", "genre": "Action", "year": 2016, "rating": 7.8, "budget": 250, "revenue": 1155, "studio": "Disney" },
          { "title": "Thor: Ragnarok", "genre": "Action", "year": 2017, "rating": 7.9, "budget": 180, "revenue": 855, "studio": "Disney" },
          { "title": "Doctor Strange", "genre": "Action", "year": 2016, "rating": 7.5, "budget": 165, "revenue": 678, "studio": "Disney" },
          { "title": "Shang-Chi and the Legend of the Ten Rings", "genre": "Action", "year": 2021, "rating": 7.4, "budget": 150, "revenue": 432, "studio": "Disney" },
          { "title": "Top Gun: Maverick", "genre": "Action", "year": 2022, "rating": 8.2, "budget": 170, "revenue": 1496, "studio": "Paramount" },
          { "title": "Barbie", "genre": "Comedy", "year": 2023, "rating": 6.8, "budget": 145, "revenue": 1446, "studio": "Warner Bros" },
          { "title": "Whiplash", "genre": "Drama", "year": 2014, "rating": 8.5, "budget": 3, "revenue": 49, "studio": "Sony" },
          { "title": "La La Land", "genre": "Drama", "year": 2016, "rating": 8.0, "budget": 30, "revenue": 447, "studio": "Lionsgate" },
          { "title": "The Social Network", "genre": "Drama", "year": 2010, "rating": 7.8, "budget": 40, "revenue": 225, "studio": "Sony" },
          { "title": "The Wolf of Wall Street", "genre": "Drama", "year": 2013, "rating": 8.2, "budget": 100, "revenue": 407, "studio": "Paramount" },
          { "title": "The Revenant", "genre": "Drama", "year": 2015, "rating": 8.0, "budget": 135, "revenue": 533, "studio": "20th Century Fox" },
          { "title": "Gravity", "genre": "Sci-Fi", "year": 2013, "rating": 7.7, "budget": 100, "revenue": 723, "studio": "Warner Bros" },
          { "title": "The Martian", "genre": "Sci-Fi", "year": 2015, "rating": 8.0, "budget": 108, "revenue": 630, "studio": "20th Century Fox" },
          { "title": "Ex Machina", "genre": "Sci-Fi", "year": 2014, "rating": 7.7, "budget": 15, "revenue": 37, "studio": "A24" },
          { "title": "Her", "genre": "Sci-Fi", "year": 2013, "rating": 8.0, "budget": 23, "revenue": 48, "studio": "Warner Bros" },
          { "title": "Edge of Tomorrow", "genre": "Sci-Fi", "year": 2014, "rating": 7.9, "budget": 178, "revenue": 371, "studio": "Warner Bros" },
          { "title": "District 9", "genre": "Sci-Fi", "year": 2009, "rating": 7.9, "budget": 30, "revenue": 211, "studio": "Sony" },
          { "title": "1917", "genre": "Drama", "year": 2019, "rating": 8.2, "budget": 95, "revenue": 385, "studio": "Universal" },
          { "title": "Dunkirk", "genre": "Drama", "year": 2017, "rating": 7.8, "budget": 100, "revenue": 527, "studio": "Warner Bros" },
          { "title": "Saving Private Ryan", "genre": "Drama", "year": 1998, "rating": 8.6, "budget": 70, "revenue": 482, "studio": "DreamWorks" },
          { "title": "Toy Story 3", "genre": "Animation", "year": 2010, "rating": 8.3, "budget": 200, "revenue": 1067, "studio": "Disney" },
          { "title": "Zootopia", "genre": "Animation", "year": 2016, "rating": 8.0, "budget": 150, "revenue": 1024, "studio": "Disney" },
          { "title": "Finding Nemo", "genre": "Animation", "year": 2003, "rating": 8.2, "budget": 94, "revenue": 940, "studio": "Disney" }
        ],
      },
    },
  },
  employees: {
    name: "Company Employee Records",
    description: "HR data for a fictional mid-size company",
    files: {
      main: {
        name: "employees.csv",
        data: ( () =>
        {
          const departments = [ "Engineering", "Marketing", "Sales", "Finance", "Operations", "HR" ];
          const titles = { Engineering: [ "Junior Dev", "Senior Dev", "Lead", "Staff Engineer", "Manager" ], Marketing: [ "Coordinator", "Specialist", "Manager", "Director" ], Sales: [ "Rep", "Senior Rep", "Account Exec", "Manager", "Director" ], Finance: [ "Analyst", "Senior Analyst", "Manager", "Controller" ], Operations: [ "Coordinator", "Specialist", "Manager", "Director" ], HR: [ "Coordinator", "Specialist", "Manager", "Director" ] };
          const names = [ "Alice Chen", "Bob Martinez", "Carol Kim", "David Okafor", "Elena Petrov", "Frank Liu", "Grace Williams", "Hassan Ahmed", "Irene Tanaka", "James Brown", "Karen Singh", "Leo Rossi", "Maria Garcia", "Nathan Park", "Olivia Jones", "Paul Schmidt", "Quinn Murphy", "Rachel Lee", "Sam Wilson", "Tanya Kovac", "Uma Patel", "Victor Reyes", "Wendy Zhang", "Xavier Diaz", "Yuki Sato", "Zara Khan", "Adam Foster", "Beth Campbell", "Carlos Ruiz", "Diana Nguyen" ];
          let id = 1;
          return names.map( ( name, i ) =>
          {
            const dept = departments[ i % departments.length ];
            const titleList = titles[ dept ];
            const seniority = Math.floor( i / departments.length );
            const title = titleList[ Math.min( seniority, titleList.length - 1 ) ];
            const tenure = 1 + ( i * 7 ) % 15;
            const baseSalary = { Engineering: 85000, Marketing: 65000, Sales: 60000, Finance: 72000, Operations: 58000, HR: 62000 };
            const salary = baseSalary[ dept ] + seniority * 15000 + tenure * 1200;
            return { id: id++, name, department: dept, title, salary, tenure_years: tenure, performance_score: 2.5 + ( ( i * 3 ) % 25 ) / 10 };
          } );
        } )(),
      },
    },
  },
  stocks: {
    name: "Daily Stock Prices",
    description: "Closing prices for 5 companies over 24 months",
    files: {
      main: {
        name: "stocks.csv",
        data: ( () =>
        {
          const companies = [ "ACME Corp", "Beta Tech", "Coral Systems", "Delta Health", "Echo Finance" ];
          const basePrices = [ 150, 85, 220, 45, 310 ];
          const rows = [];
          for ( let m = 0; m < 24; m++ )
          {
            const year = 2023 + Math.floor( m / 12 );
            const month = ( m % 12 ) + 1;
            const dateStr = `${ year }-${ String( month ).padStart( 2, "0" ) }-15`;
            companies.forEach( ( company, ci ) =>
            {
              const trend = ci % 2 === 0 ? 1.008 : 0.995;
              const noise = Math.sin( m * ( ci + 1 ) * 0.7 ) * 10 + Math.cos( m * 0.3 ) * 5;
              const price = Math.round( ( basePrices[ ci ] * Math.pow( trend, m ) + noise ) * 100 ) / 100;
              const volume = Math.round( 500000 + Math.sin( m * 0.5 ) * 200000 + ci * 100000 );
              rows.push( { date: dateStr, company, close_price: price, volume, month: m + 1 } );
            } );
          }
          return rows;
        } )(),
      },
    },
  },
  movielens: {
    name: "MovieLens (Multi-File)",
    description: "Movies and ratings as separate tables. Use Join to combine them.",
    files: {
      movies: {
        name: "movies.csv",
        "data": [
          { "movieId": 1, "title": "Toy Story", "genres": "Animation|Comedy|Children" },
          { "movieId": 2, "title": "Jumanji", "genres": "Adventure|Children|Fantasy" },
          { "movieId": 3, "title": "Grumpier Old Men", "genres": "Comedy|Romance" },
          { "movieId": 4, "title": "Waiting to Exhale", "genres": "Comedy|Drama|Romance" },
          { "movieId": 5, "title": "Father of the Bride Part II", "genres": "Comedy" },
          { "movieId": 6, "title": "Heat", "genres": "Action|Crime|Thriller" },
          { "movieId": 7, "title": "Sabrina", "genres": "Comedy|Romance" },
          { "movieId": 8, "title": "Tom and Huck", "genres": "Adventure|Children" },
          { "movieId": 9, "title": "Sudden Death", "genres": "Action" },
          { "movieId": 10, "title": "GoldenEye", "genres": "Action|Adventure|Thriller" },
          { "movieId": 11, "title": "American President", "genres": "Comedy|Drama|Romance" },
          { "movieId": 12, "title": "Dracula", "genres": "Comedy|Horror" },
          { "movieId": 13, "title": "Balto", "genres": "Animation|Children|Adventure" },
          { "movieId": 14, "title": "Nixon", "genres": "Drama" },
          { "movieId": 15, "title": "Cutthroat Island", "genres": "Action|Adventure|Romance" },
          { "movieId": 16, "title": "Casino", "genres": "Crime|Drama" },
          { "movieId": 17, "title": "Sense and Sensibility", "genres": "Drama|Romance" },
          { "movieId": 18, "title": "Four Rooms", "genres": "Comedy" },
          { "movieId": 19, "title": "Ace Ventura: When Nature Calls", "genres": "Comedy" },
          { "movieId": 20, "title": "Money Train", "genres": "Action|Comedy|Crime|Drama|Thriller" },
          { "movieId": 21, "title": "Get Shorty", "genres": "Comedy|Crime|Thriller" },
          { "movieId": 22, "title": "Copycat", "genres": "Crime|Drama|Horror|Mystery|Thriller" },
          { "movieId": 23, "title": "Assassins", "genres": "Action|Crime|Thriller" },
          { "movieId": 24, "title": "Powder", "genres": "Drama|Sci-Fi" },
          { "movieId": 25, "title": "Leaving Las Vegas", "genres": "Drama|Romance" },
          { "movieId": 26, "title": "Othello", "genres": "Drama" },
          { "movieId": 27, "title": "Now and Then", "genres": "Children|Drama" },
          { "movieId": 28, "title": "Persuasion", "genres": "Drama|Romance" },
          { "movieId": 29, "title": "The City of Lost Children", "genres": "Adventure|Drama|Fantasy|Mystery|Sci-Fi" },
          { "movieId": 30, "title": "Shanghai Triad", "genres": "Crime|Drama" },
          { "movieId": 31, "title": "Dangerous Minds", "genres": "Drama" },
          { "movieId": 32, "title": "Twelve Monkeys", "genres": "Mystery|Sci-Fi|Thriller" },
          { "movieId": 34, "title": "Babe", "genres": "Children|Drama" },
          { "movieId": 35, "title": "Carrington", "genres": "Drama|Romance" },
          { "movieId": 36, "title": "Dead Man Walking", "genres": "Crime|Drama" },
          { "movieId": 37, "title": "Across the Sea of Time", "genres": "Documentary|IMAX" },
          { "movieId": 38, "title": "It Takes Two", "genres": "Children|Comedy" },
          { "movieId": 39, "title": "Clueless", "genres": "Comedy|Romance" },
          { "movieId": 40, "title": "Cry, the Beloved Country", "genres": "Drama" },
          { "movieId": 41, "title": "Richard III", "genres": "Drama|War" },
          { "movieId": 42, "title": "Dead Presidents", "genres": "Action|Crime|Drama" },
          { "movieId": 43, "title": "Restoration", "genres": "Drama" },
          { "movieId": 44, "title": "Mortal Kombat", "genres": "Action|Adventure|Fantasy" },
          { "movieId": 45, "title": "To Die For", "genres": "Comedy|Drama|Thriller" },
          { "movieId": 46, "title": "How to Make an American Quilt", "genres": "Drama|Romance" },
          { "movieId": 47, "title": "Seven", "genres": "Mystery|Thriller" },
          { "movieId": 48, "title": "Pocahontas", "genres": "Animation|Children|Drama|Musical|Romance" },
          { "movieId": 50, "title": "The Usual Suspects", "genres": "Crime|Mystery|Thriller" },
          { "movieId": 52, "title": "Mighty Aphrodite", "genres": "Comedy|Drama|Romance" },
          { "movieId": 54, "title": "The Big Green", "genres": "Children|Comedy" },
          { "movieId": 55, "title": "Georgia", "genres": "Drama" },
          { "movieId": 57, "title": "Home for the Holidays", "genres": "Drama" },
          { "movieId": 58, "title": "The Postman", "genres": "Comedy|Drama|Romance" },
          { "movieId": 59, "title": "The Confessional", "genres": "Drama|Mystery" },
          { "movieId": 60, "title": "The Indian in the Cupboard", "genres": "Adventure|Children|Fantasy" },
          { "movieId": 61, "title": "Eye for an Eye", "genres": "Drama|Thriller" },
          { "movieId": 62, "title": "Mr. Holland's Opus", "genres": "Drama" },
          { "movieId": 63, "title": "Don't Be a Menace to South Central While Drinking Your Juice in the Hood", "genres": "Comedy|Crime" },
          { "movieId": 64, "title": "Two if by Sea", "genres": "Comedy|Romance" },
          { "movieId": 65, "title": "Bio-Dome", "genres": "Comedy" },
          { "movieId": 66, "title": "Lawnmower Man 2: Beyond Cyberspace", "genres": "Action|Sci-Fi|Thriller" },
          { "movieId": 67, "title": "Two Bits", "genres": "Drama" },
          { "movieId": 68, "title": "French Twist", "genres": "Comedy|Romance" },
          { "movieId": 69, "title": "Friday", "genres": "Comedy" },
          { "movieId": 70, "title": "From Dusk Till Dawn", "genres": "Action|Comedy|Horror|Thriller" },
          { "movieId": 71, "title": "Fair Game", "genres": "Action" },
          { "movieId": 72, "title": "Kicking and Screaming", "genres": "Comedy|Drama" },
          { "movieId": 73, "title": "Les Misérables", "genres": "Drama|War" },
          { "movieId": 74, "title": "Bed of Roses", "genres": "Drama|Romance" },
          { "movieId": 75, "title": "Big Bully", "genres": "Comedy|Drama" },
          { "movieId": 76, "title": "Screamers", "genres": "Action|Sci-Fi|Thriller" },
          { "movieId": 78, "title": "The Crossing Guard", "genres": "Action|Crime|Drama|Thriller" },
          { "movieId": 79, "title": "The Juror", "genres": "Drama|Thriller" },
          { "movieId": 80, "title": "The White Balloon", "genres": "Children|Drama" },
          { "movieId": 81, "title": "Things to Do in Denver When You're Dead", "genres": "Crime|Drama|Romance" }
        ],
      },
      ratings: {
        name: "ratings.csv",
        data: ( () =>
        {
          const rows = [];
          const rng = ( seed ) =>
          {
            let s = seed;
            return () => { s = ( s * 1103515245 + 12345 ) & 0x7fffffff; return s / 0x7fffffff; };
          };
          const rand = rng( 42 );
          for ( let userId = 1; userId <= 20; userId++ )
          {
            const numRatings = 3 + Math.floor( rand() * 8 );
            const seen = new Set();
            for ( let r = 0; r < numRatings; r++ )
            {
              let movieId = 1 + Math.floor( rand() * 15 );
              while ( seen.has( movieId ) ) movieId = 1 + Math.floor( rand() * 15 );
              seen.add( movieId );
              const rating = Math.round( ( 1 + rand() * 4 ) * 2 ) / 2;
              rows.push( { userId, movieId, rating, timestamp: 1000000000 + Math.floor( rand() * 100000000 ) } );
            }
          }
          return rows;
        } )(),
      },
    },
  },
};

// -- Transform step execution (pure functions) --
// context parameter: { dataSources: Record<string, any[]> }
// Used by join and union to look up secondary data sources.

const OPERATORS = {
  equals: ( a, b ) => String( a ) === String( b ),
  not_equals: ( a, b ) => String( a ) !== String( b ),
  greater_than: ( a, b ) => Number( a ) > Number( b ),
  less_than: ( a, b ) => Number( a ) < Number( b ),
  contains: ( a, b ) => String( a ).toLowerCase().includes( String( b ).toLowerCase() ),
  starts_with: ( a, b ) => String( a ).toLowerCase().startsWith( String( b ).toLowerCase() ),
  between: ( a, b ) =>
  {
    const [ lo, hi ] = String( b ).split( "," ).map( Number );
    return Number( a ) >= lo && Number( a ) <= hi;
  },
};

const aggregators = {
  sum: ( vals ) => vals.reduce( ( a, b ) => a + ( Number( b ) || 0 ), 0 ),
  count: ( vals ) => vals.length,
  mean: ( vals ) => { const nums = vals.map( Number ).filter( ( n ) => !isNaN( n ) ); return nums.length ? Math.round( ( nums.reduce( ( a, b ) => a + b, 0 ) / nums.length ) * 100 ) / 100 : 0; },
  median: ( vals ) => { const nums = vals.map( Number ).filter( ( n ) => !isNaN( n ) ).sort( ( a, b ) => a - b ); if ( !nums.length ) return 0; const mid = Math.floor( nums.length / 2 ); return nums.length % 2 ? nums[ mid ] : ( nums[ mid - 1 ] + nums[ mid ] ) / 2; },
  min: ( vals ) => { const nums = vals.map( Number ).filter( ( n ) => !isNaN( n ) ); return nums.length ? Math.min( ...nums ) : 0; },
  max: ( vals ) => { const nums = vals.map( Number ).filter( ( n ) => !isNaN( n ) ); return nums.length ? Math.max( ...nums ) : 0; },
  first: ( vals ) => ( vals.length ? vals[ 0 ] : null ),
  last: ( vals ) => ( vals.length ? vals[ vals.length - 1 ] : null ),
};

const applyStep = ( step, data, context ) =>
{
  if ( !data || !data.length ) return data || [];
  const sources = ( context && context.dataSources ) || {};

  switch ( step.type )
  {
    case "filter": {
      const op = OPERATORS[ step.operator ];
      // an unfinished filter passes rows through instead of emptying the table
      if ( !op || !step.column || step.value === undefined || step.value === "" ) return data;
      return data.filter( ( row ) => op( row[ step.column ], step.value ) );
    }
    case "sort": {
      const sorted = [ ...data ];
      sorted.sort( ( a, b ) =>
      {
        const va = a[ step.column ], vb = b[ step.column ];
        if ( va == null && vb == null ) return 0;
        if ( va == null ) return 1;
        if ( vb == null ) return -1;
        if ( typeof va === "number" && typeof vb === "number" ) return step.direction === "asc" ? va - vb : vb - va;
        const cmp = String( va ).localeCompare( String( vb ) );
        return step.direction === "asc" ? cmp : -cmp;
      } );
      return sorted;
    }
    case "group_aggregate": {
      const groups = {};
      data.forEach( ( row ) =>
      {
        const key = ( step.groupColumns || [] ).map( ( c ) => row[ c ] ).join( "|||" );
        if ( !groups[ key ] ) groups[ key ] = [];
        groups[ key ].push( row );
      } );
      return Object.entries( groups ).map( ( [ , rows ] ) =>
      {
        const result = {};
        ( step.groupColumns || [] ).forEach( ( c ) => { result[ c ] = rows[ 0 ][ c ]; } );
        ( step.aggregations || [] ).forEach( ( { column, fn } ) =>
        {
          const vals = rows.map( ( r ) => r[ column ] );
          const aggFn = aggregators[ fn ] || aggregators.count;
          result[ `${ column }_${ fn }` ] = aggFn( vals );
        } );
        return result;
      } );
    }
    case "compute": {
      return data.map( ( row ) =>
      {
        const newRow = { ...row };
        try
        {
          const expr = step.expression || "";
          const colRefs = Object.keys( row );
          let evalExpr = expr;
          colRefs.sort( ( a, b ) => b.length - a.length );
          colRefs.forEach( ( col ) =>
          {
            const re = new RegExp( `\\b${ col.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" ) }\\b`, "g" );
            evalExpr = evalExpr.replace( re, `(${ Number( row[ col ] ) || 0 })` );
          } );
          const fn = new Function( `return ${ evalExpr }` );
          newRow[ step.newColumn || "computed" ] = Math.round( fn() * 100 ) / 100;
        } catch
        {
          newRow[ step.newColumn || "computed" ] = null;
        }
        return newRow;
      } );
    }
    case "rename": {
      return data.map( ( row ) =>
      {
        const newRow = {};
        Object.entries( row ).forEach( ( [ k, v ] ) =>
        {
          newRow[ k === step.column ? ( step.newName || k ) : k ] = v;
        } );
        return newRow;
      } );
    }
    case "drop": {
      const dropCols = new Set( step.columns || [] );
      return data.map( ( row ) =>
      {
        const newRow = {};
        Object.entries( row ).forEach( ( [ k, v ] ) =>
        {
          if ( !dropCols.has( k ) ) newRow[ k ] = v;
        } );
        return newRow;
      } );
    }
    case "top_n": {
      const sorted = [ ...data ].sort( ( a, b ) =>
      {
        const va = Number( a[ step.column ] ) || 0;
        const vb = Number( b[ step.column ] ) || 0;
        return step.direction === "bottom" ? va - vb : vb - va;
      } );
      return sorted.slice( 0, step.n || 10 );
    }
    case "pivot": {
      const groups = {};
      data.forEach( ( row ) =>
      {
        const key = row[ step.rowColumn ];
        if ( !groups[ key ] ) groups[ key ] = { [ step.rowColumn ]: key };
        groups[ key ][ String( row[ step.pivotColumn ] ) ] = row[ step.valueColumn ];
      } );
      return Object.values( groups );
    }
    case "unpivot": {
      const idCols = step.idColumns || [];
      const result = [];
      data.forEach( ( row ) =>
      {
        Object.entries( row ).forEach( ( [ k, v ] ) =>
        {
          if ( !idCols.includes( k ) )
          {
            const newRow = {};
            idCols.forEach( ( c ) => { newRow[ c ] = row[ c ]; } );
            newRow[ step.nameColumn || "variable" ] = k;
            newRow[ step.valueColumnName || "value" ] = v;
            result.push( newRow );
          }
        } );
      } );
      return result;
    }
    // v2: new operations
    case "join": {
      const rightSource = step.rightSource || "";
      const rightData = sources[ rightSource ];
      if ( !rightData || !rightData.length ) return data;
      const leftKey = step.leftKey || "";
      const rightKey = step.rightKey || "";
      if ( !leftKey || !rightKey ) return data;
      const joinType = step.joinType || "inner";
      // build hash index on right side
      const rightIndex = {};
      rightData.forEach( ( row ) =>
      {
        const k = String( row[ rightKey ] );
        if ( !rightIndex[ k ] ) rightIndex[ k ] = [];
        rightIndex[ k ].push( row );
      } );
      const result = [];
      if ( joinType === "inner" || joinType === "left" )
      {
        data.forEach( ( leftRow ) =>
        {
          const k = String( leftRow[ leftKey ] );
          const matches = rightIndex[ k ];
          if ( matches && matches.length > 0 )
          {
            matches.forEach( ( rightRow ) =>
            {
              const merged = { ...leftRow };
              Object.entries( rightRow ).forEach( ( [ col, val ] ) =>
              {
                if ( col === rightKey && leftKey !== rightKey ) merged[ col ] = val;
                else if ( col !== rightKey ) merged[ col in merged ? `${ rightSource }_${ col }` : col ] = val;
              } );
              result.push( merged );
            } );
          } else if ( joinType === "left" )
          {
            result.push( { ...leftRow } );
          }
        } );
      }
      if ( joinType === "right" )
      {
        const leftIndex = {};
        data.forEach( ( row ) =>
        {
          const k = String( row[ leftKey ] );
          if ( !leftIndex[ k ] ) leftIndex[ k ] = [];
          leftIndex[ k ].push( row );
        } );
        rightData.forEach( ( rightRow ) =>
        {
          const k = String( rightRow[ rightKey ] );
          const matches = leftIndex[ k ];
          if ( matches && matches.length > 0 )
          {
            matches.forEach( ( leftRow ) =>
            {
              const merged = { ...leftRow };
              Object.entries( rightRow ).forEach( ( [ col, val ] ) =>
              {
                if ( col === rightKey && leftKey !== rightKey ) merged[ col ] = val;
                else if ( col !== rightKey ) merged[ col in merged ? `${ rightSource }_${ col }` : col ] = val;
              } );
              result.push( merged );
            } );
          } else
          {
            result.push( { ...rightRow } );
          }
        } );
      }
      return result;
    }
    case "union": {
      const unionSource = step.unionSource || "";
      const unionData = sources[ unionSource ];
      if ( !unionData || !unionData.length ) return data;
      return [ ...data, ...unionData ];
    }
    case "distinct": {
      const distinctCols = step.columns || Object.keys( data[ 0 ] );
      const seen = new Set();
      return data.filter( ( row ) =>
      {
        const key = distinctCols.map( ( c ) => String( row[ c ] ) ).join( "|||" );
        if ( seen.has( key ) ) return false;
        seen.add( key );
        return true;
      } );
    }
    case "fill_null": {
      const col = step.column || "";
      const fillVal = step.fillValue;
      const strategy = step.strategy || "value";
      return data.map( ( row, i ) =>
      {
        if ( row[ col ] !== null && row[ col ] !== undefined && row[ col ] !== "" ) return row;
        const newRow = { ...row };
        if ( strategy === "forward" && i > 0 ) newRow[ col ] = data[ i - 1 ][ col ];
        else if ( strategy === "backward" && i < data.length - 1 ) newRow[ col ] = data[ i + 1 ][ col ];
        else newRow[ col ] = fillVal;
        return newRow;
      } );
    }
    case "sample": {
      const n = Math.min( step.n || 10, data.length );
      const shuffled = [ ...data ];
      // Fisher-Yates
      for ( let i = shuffled.length - 1; i > 0; i-- )
      {
        const j = Math.floor( Math.random() * ( i + 1 ) );
        [ shuffled[ i ], shuffled[ j ] ] = [ shuffled[ j ], shuffled[ i ] ];
      }
      return shuffled.slice( 0, n );
    }
    case "window": {
      const col = step.column || "";
      const fn = step.windowFn || "running_sum";
      const newCol = step.newColumn || `${ col }_${ fn }`;
      const sorted = step.orderColumn ? [ ...data ].sort( ( a, b ) =>
      {
        const va = a[ step.orderColumn ], vb = b[ step.orderColumn ];
        if ( typeof va === "number" ) return va - vb;
        return String( va ).localeCompare( String( vb ) );
      } ) : [ ...data ];
      let running = 0;
      let count = 0;
      return sorted.map( ( row, i ) =>
      {
        const val = Number( row[ col ] ) || 0;
        const newRow = { ...row };
        if ( fn === "running_sum" ) { running += val; newRow[ newCol ] = Math.round( running * 100 ) / 100; }
        else if ( fn === "running_avg" ) { running += val; count++; newRow[ newCol ] = Math.round( ( running / count ) * 100 ) / 100; }
        else if ( fn === "row_number" ) { newRow[ newCol ] = i + 1; }
        else if ( fn === "rank" )
        {
          if ( i === 0 || row[ col ] !== sorted[ i - 1 ][ col ] ) newRow[ newCol ] = i + 1;
          else newRow[ newCol ] = sorted[ i - 1 ][ newCol ] || i + 1;
          // patch: copy rank to a temp for next iteration reference
        }
        else if ( fn === "lag" ) { newRow[ newCol ] = i > 0 ? sorted[ i - 1 ][ col ] : null; }
        else if ( fn === "lead" ) { newRow[ newCol ] = i < sorted.length - 1 ? sorted[ i + 1 ][ col ] : null; }
        return newRow;
      } );
    }
    case "cast_type": {
      const col = step.column || "";
      const targetType = step.targetType || "string";
      return data.map( ( row ) =>
      {
        const newRow = { ...row };
        const val = row[ col ];
        if ( targetType === "number" ) newRow[ col ] = val === null || val === "" ? null : Number( val );
        else if ( targetType === "string" ) newRow[ col ] = val === null ? null : String( val );
        else if ( targetType === "boolean" ) newRow[ col ] = Boolean( val ) && val !== "false" && val !== "0";
        return newRow;
      } );
    }
    default:
      return data;
  }
};

// Build a pipeline function from step descriptors, threading context
const buildPipeline = ( steps, context ) =>
{
  const enabledSteps = steps.filter( ( s ) => s.enabled !== false );
  if ( enabledSteps.length === 0 ) return identity;
  return enabledSteps.reduce(
    ( fn, step ) => ( data ) => applyStep( step, fn( data ), context ),
    identity
  );
};

const executePipelineUpTo = ( steps, data, upTo, context ) =>
{
  const active = steps.slice( 0, upTo + 1 ).filter( ( s ) => s.enabled !== false );
  return buildPipeline( active, context )( data );
};

// -- Query plan builder --

const buildLogicalPlan = ( steps, sourceName, rowCount ) =>
{
  const nodes = [];
  nodes.push( { id: "scan", type: "Scan", label: `Scan(${ sourceName })`, rows: rowCount, details: `${ rowCount } rows` } );
  const enabledSteps = steps.filter( ( s ) => s.enabled !== false );
  enabledSteps.forEach( ( step, i ) =>
  {
    const nodeId = `step_${ i }`;
    let label = "";
    let details = "";
    switch ( step.type )
    {
      case "filter": label = `Filter`; details = `${ step.column } ${ step.operator } ${ step.value }`; break;
      case "sort": label = `Sort`; details = `${ step.column } ${ step.direction }`; break;
      case "group_aggregate": label = `Aggregate`; details = `group by [${ ( step.groupColumns || [] ).join( ", " ) }]`; break;
      case "compute": label = `Project`; details = `${ step.newColumn } = ${ step.expression }`; break;
      case "rename": label = `Rename`; details = `${ step.column } -> ${ step.newName }`; break;
      case "drop": label = `Drop`; details = `[${ ( step.columns || [] ).join( ", " ) }]`; break;
      case "top_n": label = `Limit`; details = `${ step.direction || "top" } ${ step.n } by ${ step.column }`; break;
      case "pivot": label = `Pivot`; details = `${ step.rowColumn } x ${ step.pivotColumn }`; break;
      case "unpivot": label = `Unpivot`; details = `id=[${ ( step.idColumns || [] ).join( "," ) }]`; break;
      case "join": label = `Join`; details = `${ step.joinType || "inner" } on ${ step.leftKey }=${ step.rightKey }`; break;
      case "union": label = `Union`; details = `with ${ step.unionSource }`; break;
      case "distinct": label = `Distinct`; details = `[${ ( step.columns || [] ).join( ", " ) || "all" }]`; break;
      case "fill_null": label = `FillNull`; details = `${ step.column } <- ${ step.strategy || "value" }`; break;
      case "sample": label = `Sample`; details = `n=${ step.n || 10 }`; break;
      case "window": label = `Window`; details = `${ step.windowFn }(${ step.column })`; break;
      case "cast_type": label = `Cast`; details = `${ step.column } -> ${ step.targetType }`; break;
      default: label = step.type; details = "";
    }
    nodes.push( { id: nodeId, type: label, label: `${ label }`, details, stepType: step.type } );
  } );
  return nodes;
};

// Optimizer: applies rules to reorder/fuse steps
const optimizePipeline = ( steps ) =>
{
  const rules = [];
  let optimized = steps.filter( ( s ) => s.enabled !== false ).map( ( s ) => ( { ...s } ) );

  // Rule 1: Predicate pushdown -- move filters before sorts, computes, renames
  let pushed = true;
  while ( pushed )
  {
    pushed = false;
    for ( let i = 1; i < optimized.length; i++ )
    {
      if ( optimized[ i ].type === "filter" )
      {
        const prev = optimized[ i - 1 ];
        if ( [ "sort", "compute", "rename" ].includes( prev.type ) )
        {
          // check the filter doesn't depend on the computed column
          if ( prev.type === "compute" && optimized[ i ].column === prev.newColumn ) continue;
          if ( prev.type === "rename" && optimized[ i ].column === prev.newName ) continue;
          [ optimized[ i - 1 ], optimized[ i ] ] = [ optimized[ i ], optimized[ i - 1 ] ];
          rules.push( { rule: "Predicate Pushdown", desc: `Moved Filter(${ optimized[ i - 1 ].column }) before ${ prev.type }` } );
          pushed = true;
        }
      }
    }
  }

  // Rule 2: Filter fusion -- merge consecutive filters into one logical AND
  for ( let i = 0; i < optimized.length - 1; i++ )
  {
    if ( optimized[ i ].type === "filter" && optimized[ i + 1 ].type === "filter" )
    {
      rules.push( { rule: "Filter Fusion", desc: `Can fuse Filter(${ optimized[ i ].column }) AND Filter(${ optimized[ i + 1 ].column })` } );
      // note: we keep them separate in execution but note the optimization opportunity
    }
  }

  // Rule 3: Sort elimination -- remove sort before group_aggregate (grouping discards order)
  for ( let i = 0; i < optimized.length - 1; i++ )
  {
    if ( optimized[ i ].type === "sort" && optimized[ i + 1 ].type === "group_aggregate" )
    {
      rules.push( { rule: "Sort Elimination", desc: `Sort(${ optimized[ i ].column }) before Aggregate is unnecessary` } );
    }
  }

  // Rule 4: Projection pushdown -- if a drop appears, note that columns can be eliminated earlier
  for ( let i = 0; i < optimized.length; i++ )
  {
    if ( optimized[ i ].type === "drop" && i > 0 )
    {
      rules.push( { rule: "Projection Pushdown", desc: `Drop([${ ( optimized[ i ].columns || [] ).join( "," ) }]) can be pushed to scan phase` } );
    }
  }

  return { steps: optimized, rules };
};

// Build physical plan nodes from logical + engine
const buildPhysicalPlan = ( logicalNodes, engine ) =>
{
  return logicalNodes.map( ( node ) =>
  {
    const stepType = node.stepType || ( node.type === "Scan" ? "scan" : node.type.toLowerCase() );
    const engineOp = ENGINE_OPS[ stepType ];
    const physicalOp = engineOp ? engineOp[ engine ] : `${ engine }: ${ node.type }`;
    return { ...node, physicalOp: physicalOp || node.label, engine };
  } );
};

// -- Code generation --

const generateCode = ( steps, chartConfig, engine ) =>
{
  let code = `// Prism v4 -- Generated Data Pipeline\n// Engine: ${ ENGINES[ engine || "js" ].name }\n// Pure functional data transformation\n\n`;
  code += `// pipe: compose functions left-to-right\nconst pipe = (...fns: Array<(data: any[]) => any[]>) =>\n  (x: any[]) => fns.reduce((v, f) => f(v), x);\n\n`;
  code += `const identity = <T>(x: T): T => x;\n\n`;

  const fnNames = [];
  steps.filter( ( s ) => s.enabled !== false ).forEach( ( step, i ) =>
  {
    const fnName = `step${ i + 1 }_${ step.type }`;
    fnNames.push( fnName );
    const eOp = ENGINE_OPS[ step.type ];
    if ( engine && engine !== "js" && eOp )
    {
      code += `// Step ${ i + 1 } [${ step.type }]\n`;
      code += `// JS:    ${ eOp.js }\n`;
      code += `// ${ engine === "arrow" ? "Arrow" : "WebGPU" }: ${ eOp[ engine ] }\n`;
    }
    switch ( step.type )
    {
      case "filter":
        code += `// Step ${ i + 1 }: Filter rows where ${ step.column } ${ step.operator } ${ step.value }\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.filter(row => {\n`;
        if ( step.operator === "contains" ) code += `    return String(row["${ step.column }"]).toLowerCase().includes("${ step.value }".toLowerCase());\n`;
        else if ( step.operator === "starts_with" ) code += `    return String(row["${ step.column }"]).toLowerCase().startsWith("${ step.value }".toLowerCase());\n`;
        else if ( step.operator === "between" ) { const [ lo, hi ] = String( step.value ).split( "," ); code += `    const v = Number(row["${ step.column }"]);\n    return v >= ${ lo } && v <= ${ hi };\n`; }
        else { const op = { equals: "===", not_equals: "!==", greater_than: ">", less_than: "<" }[ step.operator ] || "==="; code += `    return row["${ step.column }"] ${ op } ${ isNaN( step.value ) ? `"${ step.value }"` : step.value };\n`; }
        code += `  });\n\n`;
        break;
      case "sort":
        code += `// Step ${ i + 1 }: Sort by ${ step.column } (${ step.direction })\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  [...data].sort((a, b) => {\n`;
        code += `    const va = a["${ step.column }"], vb = b["${ step.column }"];\n`;
        code += `    if (typeof va === "number") return ${ step.direction === "asc" ? "va - vb" : "vb - va" };\n`;
        code += `    return ${ step.direction === "asc" ? 'String(va).localeCompare(String(vb))' : 'String(vb).localeCompare(String(va))' };\n`;
        code += `  });\n\n`;
        break;
      case "group_aggregate":
        code += `// Step ${ i + 1 }: Group by [${ ( step.groupColumns || [] ).join( ", " ) }] and aggregate\n`;
        code += `const ${ fnName } = (data: any[]) => {\n`;
        code += `  const groups: Record<string, any[]> = {};\n`;
        code += `  data.forEach(row => {\n`;
        code += `    const key = [${ ( step.groupColumns || [] ).map( ( c ) => `row["${ c }"]` ).join( ", " ) }].join("|||");\n`;
        code += `    if (!groups[key]) groups[key] = [];\n`;
        code += `    groups[key].push(row);\n`;
        code += `  });\n`;
        code += `  return Object.values(groups).map(rows => ({\n`;
        ( step.groupColumns || [] ).forEach( ( c ) => { code += `    ${ c }: rows[0]["${ c }"],\n`; } );
        ( step.aggregations || [] ).forEach( ( { column, fn } ) =>
        {
          code += `    ${ column }_${ fn }: rows.map(r => r["${ column }"]).reduce(/* ${ fn } */),\n`;
        } );
        code += `  }));\n};\n\n`;
        break;
      case "compute":
        code += `// Step ${ i + 1 }: Compute new column "${ step.newColumn }" = ${ step.expression }\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.map(row => ({\n    ...row,\n    ${ step.newColumn || "computed" }: ${ step.expression || "0" },\n  }));\n\n`;
        break;
      case "rename":
        code += `// Step ${ i + 1 }: Rename "${ step.column }" to "${ step.newName }"\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.map(row => {\n    const { ["${ step.column }"]: val, ...rest } = row;\n    return { ...rest, ["${ step.newName }"]: val };\n  });\n\n`;
        break;
      case "drop":
        code += `// Step ${ i + 1 }: Drop columns [${ ( step.columns || [] ).join( ", " ) }]\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.map(({ ${ ( step.columns || [] ).join( ", " ) }, ...rest }) => rest);\n\n`;
        break;
      case "top_n":
        code += `// Step ${ i + 1 }: ${ step.direction === "bottom" ? "Bottom" : "Top" } ${ step.n } by ${ step.column }\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  [...data]\n    .sort((a, b) => ${ step.direction === "bottom" ? `a["${ step.column }"] - b["${ step.column }"]` : `b["${ step.column }"] - a["${ step.column }"]` })\n    .slice(0, ${ step.n || 10 });\n\n`;
        break;
      case "join":
        code += `// Step ${ i + 1 }: ${ step.joinType || "inner" } join on ${ step.leftKey } = ${ step.rightKey }\n`;
        code += `const ${ fnName } = (data: any[], context: { dataSources: Record<string, any[]> }) => {\n`;
        code += `  const right = context.dataSources["${ step.rightSource }"];\n`;
        code += `  const index = new Map<string, any[]>();\n`;
        code += `  right.forEach(r => {\n`;
        code += `    const k = String(r["${ step.rightKey }"]);\n`;
        code += `    if (!index.has(k)) index.set(k, []);\n`;
        code += `    index.get(k)!.push(r);\n`;
        code += `  });\n`;
        code += `  // hash join: build on right, probe with left\n`;
        code += `  return data.flatMap(left => {\n`;
        code += `    const matches = index.get(String(left["${ step.leftKey }"])) || [];\n`;
        code += `    return matches.map(right => ({ ...left, ...right }));\n`;
        code += `  });\n};\n\n`;
        break;
      case "union":
        code += `// Step ${ i + 1 }: Union with "${ step.unionSource }"\n`;
        code += `const ${ fnName } = (data: any[], context: { dataSources: Record<string, any[]> }) =>\n`;
        code += `  [...data, ...context.dataSources["${ step.unionSource }"]];\n\n`;
        break;
      case "distinct":
        code += `// Step ${ i + 1 }: Distinct on [${ ( step.columns || [] ).join( ", " ) || "all columns" }]\n`;
        code += `const ${ fnName } = (data: any[]) => {\n`;
        code += `  const seen = new Set<string>();\n`;
        code += `  return data.filter(row => {\n`;
        code += `    const key = [${ ( step.columns || [ "..." ] ).map( ( c ) => `row["${ c }"]` ).join( "," ) }].join("|||");\n`;
        code += `    if (seen.has(key)) return false;\n`;
        code += `    seen.add(key);\n    return true;\n  });\n};\n\n`;
        break;
      case "fill_null":
        code += `// Step ${ i + 1 }: Fill null in "${ step.column }" (${ step.strategy || "value" })\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.map((row, i) => ({\n    ...row,\n    ${ step.column }: row["${ step.column }"] ?? ${ JSON.stringify( step.fillValue ) },\n  }));\n\n`;
        break;
      case "sample":
        code += `// Step ${ i + 1 }: Random sample of ${ step.n || 10 }\n`;
        code += `const ${ fnName } = (data: any[]) => {\n`;
        code += `  const shuffled = [...data];\n`;
        code += `  for (let i = shuffled.length - 1; i > 0; i--) {\n`;
        code += `    const j = Math.floor(Math.random() * (i + 1));\n`;
        code += `    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];\n`;
        code += `  }\n  return shuffled.slice(0, ${ step.n || 10 });\n};\n\n`;
        break;
      case "window":
        code += `// Step ${ i + 1 }: Window ${ step.windowFn }(${ step.column })\n`;
        code += `const ${ fnName } = (data: any[]) => {\n`;
        code += `  let running = 0;\n  let count = 0;\n`;
        code += `  return data.map((row, i) => ({\n    ...row,\n`;
        code += `    ${ step.newColumn || step.column + "_" + step.windowFn }: /* ${ step.windowFn } logic */,\n`;
        code += `  }));\n};\n\n`;
        break;
      case "cast_type":
        code += `// Step ${ i + 1 }: Cast "${ step.column }" to ${ step.targetType }\n`;
        code += `const ${ fnName } = (data: any[]) =>\n  data.map(row => ({\n    ...row,\n    ${ step.column }: ${ step.targetType === "number" ? `Number(row["${ step.column }"])` : `String(row["${ step.column }"])` },\n  }));\n\n`;
        break;
      default:
        code += `// Step ${ i + 1 }: ${ step.type }\nconst ${ fnName } = identity;\n\n`;
    }
  } );

  if ( fnNames.length > 0 )
  {
    code += `// Compose the full pipeline\nconst transform = pipe(\n  ${ fnNames.join( ",\n  " ) }\n);\n\n`;
    code += `// Execute: const result = transform(rawData);\n`;
  }

  if ( chartConfig && chartConfig.type )
  {
    code += `\n// Chart configuration\nconst chartConfig = ${ JSON.stringify( chartConfig, null, 2 ) };\n`;
  }

  return code;
};

// -- DuckDB SQL generation --

const escSQL = ( v ) => String( v ).replace( /'/g, "''" );
const qid = ( name ) => `"${ ( name || "" ).replace( /"/g, '""' ) }"`;

const AGG_TO_SQL = {
  sum: "SUM", count: "COUNT", mean: "AVG", median: "MEDIAN",
  min: "MIN", max: "MAX", first: "FIRST", last: "LAST",
};

const stepToSQL = ( step, fromTable ) =>
{
  switch ( step.type )
  {
    case "filter": {
      if ( step.operator === "contains" )
        return `SELECT * FROM ${ fromTable } WHERE CAST(${ qid( step.column ) } AS VARCHAR) ILIKE '%${ escSQL( step.value ) }%'`;
      if ( step.operator === "starts_with" )
        return `SELECT * FROM ${ fromTable } WHERE CAST(${ qid( step.column ) } AS VARCHAR) ILIKE '${ escSQL( step.value ) }%'`;
      if ( step.operator === "between" )
      {
        const [ lo, hi ] = String( step.value ).split( "," ).map( s => s.trim() );
        return `SELECT * FROM ${ fromTable } WHERE ${ qid( step.column ) } BETWEEN ${ lo } AND ${ hi }`;
      }
      const sqlOps = { equals: "=", not_equals: "!=", greater_than: ">", less_than: "<" };
      const op = sqlOps[ step.operator ] || "=";
      const val = isNaN( Number( step.value ) ) ? `'${ escSQL( step.value ) }'` : step.value;
      return `SELECT * FROM ${ fromTable } WHERE ${ qid( step.column ) } ${ op } ${ val }`;
    }
    case "sort":
      return `SELECT * FROM ${ fromTable } ORDER BY ${ qid( step.column ) } ${ step.direction === "desc" ? "DESC" : "ASC" }`;
    case "group_aggregate": {
      const groupCols = ( step.groupColumns || [] ).map( c => qid( c ) );
      const aggs = ( step.aggregations || [] ).map( a =>
      {
        const fn = AGG_TO_SQL[ a.fn ] || "COUNT";
        return `${ fn }(${ qid( a.column ) }) AS "${ a.column }_${ a.fn }"`;
      } );
      const selectParts = [ ...groupCols, ...aggs ];
      if ( selectParts.length === 0 ) return `SELECT * FROM ${ fromTable }`;
      return `SELECT ${ selectParts.join( ", " ) } FROM ${ fromTable } GROUP BY ${ groupCols.join( ", " ) }`;
    }
    case "compute":
      return `SELECT *, (${ step.expression || "0" }) AS ${ qid( step.newColumn || "computed" ) } FROM ${ fromTable }`;
    case "rename":
      return `SELECT * EXCLUDE (${ qid( step.column ) }), ${ qid( step.column ) } AS ${ qid( step.newName || step.column ) } FROM ${ fromTable }`;
    case "drop":
      return `SELECT * EXCLUDE (${ ( step.columns || [] ).map( c => qid( c ) ).join( ", " ) }) FROM ${ fromTable }`;
    case "top_n":
      return `SELECT * FROM ${ fromTable } ORDER BY ${ qid( step.column ) } ${ step.direction === "bottom" ? "ASC" : "DESC" } LIMIT ${ step.n || 10 }`;
    case "pivot":
      return `PIVOT ${ fromTable } ON ${ qid( step.pivotColumn ) } USING FIRST(${ qid( step.valueColumn ) }) GROUP BY ${ qid( step.rowColumn ) }`;
    case "unpivot": {
      const idCols = ( step.idColumns || [] ).map( c => qid( c ) ).join( ", " );
      return `UNPIVOT ${ fromTable } ON COLUMNS(* EXCLUDE (${ idCols })) INTO NAME ${ qid( step.nameColumn || "variable" ) } VALUE ${ qid( step.valueColumnName || "value" ) }`;
    }
    case "join": {
      const jt = { inner: "INNER", left: "LEFT", right: "RIGHT" }[ step.joinType || "inner" ] || "INNER";
      const rt = qid( step.rightSource || "" );
      return `SELECT * FROM ${ fromTable } ${ jt } JOIN ${ rt } ON ${ fromTable }.${ qid( step.leftKey ) } = ${ rt }.${ qid( step.rightKey ) }`;
    }
    case "union":
      return `SELECT * FROM ${ fromTable } UNION ALL SELECT * FROM ${ qid( step.unionSource || "" ) }`;
    case "distinct": {
      const cols = step.columns && step.columns.length > 0 ? step.columns.map( c => qid( c ) ) : null;
      if ( !cols ) return `SELECT DISTINCT * FROM ${ fromTable }`;
      return `SELECT DISTINCT ON (${ cols.join( ", " ) }) * FROM ${ fromTable }`;
    }
    case "fill_null": {
      const col = qid( step.column || "" );
      if ( step.strategy === "forward" )
        return `SELECT * EXCLUDE (${ col }), COALESCE(${ col }, LAG(${ col }) OVER ()) AS ${ col } FROM ${ fromTable }`;
      if ( step.strategy === "backward" )
        return `SELECT * EXCLUDE (${ col }), COALESCE(${ col }, LEAD(${ col }) OVER ()) AS ${ col } FROM ${ fromTable }`;
      const fv = isNaN( Number( step.fillValue ) ) ? `'${ escSQL( step.fillValue || "" ) }'` : ( step.fillValue || "0" );
      return `SELECT * EXCLUDE (${ col }), COALESCE(${ col }, ${ fv }) AS ${ col } FROM ${ fromTable }`;
    }
    case "sample":
      return `SELECT * FROM ${ fromTable } USING SAMPLE ${ step.n || 10 }`;
    case "window": {
      const col = qid( step.column || "" );
      const newCol = qid( step.newColumn || `${ step.column }_${ step.windowFn }` );
      const orderClause = step.orderColumn ? `ORDER BY ${ qid( step.orderColumn ) }` : "";
      const winMap = {
        running_sum: `SUM(${ col }) OVER (${ orderClause } ROWS UNBOUNDED PRECEDING)`,
        running_avg: `AVG(${ col }) OVER (${ orderClause } ROWS UNBOUNDED PRECEDING)`,
        row_number: `ROW_NUMBER() OVER (${ orderClause })`,
        rank: `RANK() OVER (${ orderClause })`,
        lag: `LAG(${ col }) OVER (${ orderClause })`,
        lead: `LEAD(${ col }) OVER (${ orderClause })`,
      };
      return `SELECT *, ${ winMap[ step.windowFn || "running_sum" ] || `SUM(${ col }) OVER ()` } AS ${ newCol } FROM ${ fromTable }`;
    }
    case "cast_type": {
      const col = qid( step.column || "" );
      const typeMap = { number: "DOUBLE", string: "VARCHAR", boolean: "BOOLEAN" };
      return `SELECT * EXCLUDE (${ col }), CAST(${ col } AS ${ typeMap[ step.targetType || "string" ] || "VARCHAR" }) AS ${ col } FROM ${ fromTable }`;
    }
    default:
      return `SELECT * FROM ${ fromTable }`;
  }
};

const pipelineToSQL = ( steps, tableName ) =>
{
  const enabled = steps.filter( s => s.enabled !== false );
  if ( enabled.length === 0 ) return `SELECT * FROM ${ qid( tableName ) }`;
  const parts = [];
  enabled.forEach( ( step, i ) =>
  {
    const prev = i === 0 ? qid( tableName ) : `step_${ i - 1 }`;
    parts.push( `step_${ i } AS (\n  ${ stepToSQL( step, prev ) }\n)` );
  } );
  return `WITH ${ parts.join( ",\n" ) }\nSELECT * FROM step_${ enabled.length - 1 }`;
};

const generateDuckDBCode = ( steps, tableName, dataSources ) =>
{
  let code = `-- Prism v4 -- DuckDB SQL Pipeline\n-- Engine: DuckDB (WASM)\n-- Generated from ${ steps.filter( s => s.enabled !== false ).length } pipeline steps\n\n`;
  code += `-- Initialize DuckDB-WASM\n`;
  code += `-- import * as duckdb from "@duckdb/duckdb-wasm";\n`;
  code += `-- const BUNDLES = duckdb.getJsDelivrBundles();\n`;
  code += `-- const bundle = await duckdb.selectBundle(BUNDLES);\n`;
  code += `-- const worker = new Worker(URL.createObjectURL(\n`;
  code += `--   new Blob([\`importScripts("\${bundle.mainWorker}");\`], {type:"text/javascript"})\n`;
  code += `-- ));\n`;
  code += `-- const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);\n`;
  code += `-- await db.instantiate(bundle.mainModule, bundle.pthreadWorker);\n`;
  code += `-- const conn = await db.connect();\n\n`;
  // table creation for each source
  Object.entries( dataSources ).forEach( ( [ name, data ] ) =>
  {
    if ( !data || !data.length ) return;
    const cols = Object.keys( data[ 0 ] );
    const colDefs = cols.map( c =>
    {
      const sample = data.find( r => r[ c ] !== null && r[ c ] !== undefined && r[ c ] !== "" );
      const val = sample ? sample[ c ] : "";
      return `${ qid( c ) } ${ typeof val === "number" ? "DOUBLE" : "VARCHAR" }`;
    } ).join( ", " );
    code += `CREATE TABLE ${ qid( name ) } (${ colDefs });\n`;
    code += `-- INSERT ${ data.length } rows into ${ qid( name ) }...\n\n`;
  } );
  code += `-- Pipeline query\n`;
  code += pipelineToSQL( steps, tableName ) + ";\n\n";
  code += `-- Get query plans\n`;
  code += `PRAGMA explain_output = 'optimized_only';\n`;
  code += `EXPLAIN\n${ pipelineToSQL( steps, tableName ) };\n\n`;
  code += `PRAGMA explain_output = 'physical_only';\n`;
  code += `EXPLAIN\n${ pipelineToSQL( steps, tableName ) };\n`;
  return code;
};

// -- Pipeline reducer --

const nextId = ( () => { let n = 0; return () => ++n; } )();

const pipelineReducer = ( state, action ) =>
{
  switch ( action.type )
  {
    case "ADD_STEP": {
      const step = { ...action.step, id: action.step.id || nextId(), enabled: true };
      const at = action.index === undefined ? state.length : action.index;
      return [ ...state.slice( 0, at ), step, ...state.slice( at ) ];
    }
    case "REMOVE_STEP":
      return state.filter( ( s ) => s.id !== action.id );
    case "UPDATE_STEP":
      return state.map( ( s ) => ( s.id === action.id ? { ...s, ...action.updates } : s ) );
    case "TOGGLE_STEP":
      return state.map( ( s ) => ( s.id === action.id ? { ...s, enabled: !s.enabled } : s ) );
    case "REORDER": {
      const arr = [ ...state ];
      const [ moved ] = arr.splice( action.from, 1 );
      arr.splice( action.to, 0, moved );
      return arr;
    }
    case "LOAD":
      return action.steps || [];
    case "CLEAR":
      return [];
    default:
      return state;
  }
};

// -- Themes: Sorbet (light pastel) and Meadow (dark pastel) --

const THEMES = {
  sorbet: {
    name: "Sorbet", dark: false, swatch: [ "#F5A57A", "#9C86E8" ],
    bg: "#FBF7F4", surf: "#FFFFFF", soft: "#F5EFEA", ink: "#2A2433", mute: "#655E70", line: "#ECE4DE",
    acc: "#6E54C9", onAcc: "#FFFFFF", accSoft: "#E7E0FB", accInk: "#4A3399", codeBg: "#F7F3FB",
    rowsBg: "#FFE1CF", rowsInk: "#8A3B12", colsBg: "#E6DEFF", colsInk: "#4B2FA6", sumBg: "#CFF0E4", sumInk: "#0E6650",
    cmbBg: "#D6E7FF", cmbInk: "#1F4E9C", clnBg: "#FFD9E7", clnInk: "#9A2252",
    series: [ "#9C86E8", "#6FC7A8", "#F5A57A", "#7FAEEB", "#EE8FB2", "#D4B85A", "#5BBFC4", "#C48BD9" ],
  },
  meadow: {
    name: "Meadow", dark: true, swatch: [ "#1A2423", "#6FD0B5" ],
    bg: "#121A19", surf: "#1A2423", soft: "#223030", ink: "#E4EEEB", mute: "#9DB0AB", line: "#2C3B39",
    acc: "#6FD0B5", onAcc: "#0E1A17", accSoft: "#1F3D36", accInk: "#9FE5D0", codeBg: "#16201F",
    rowsBg: "#3D3020", rowsInk: "#F4C98E", colsBg: "#2A2F4D", colsInk: "#B9C4F6", sumBg: "#1F3A2A", sumInk: "#A9DEB6",
    cmbBg: "#1C3A3E", cmbInk: "#9EDCE3", clnBg: "#40252C", clnInk: "#F2B3C0",
    series: [ "#6FC9AA", "#9AAEF2", "#EDB672", "#74CBD6", "#E99DAD", "#D9C46A", "#B79AF0", "#8FD39A" ],
  },
};

const MONO = "'IBM Plex Mono', 'SF Mono', monospace";

const makeStyles = ( t ) => ( {
  app: { fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: t.bg, color: t.ink, minHeight: "100vh", fontSize: 14 },
  main: { maxWidth: 1280, margin: "0 auto", padding: "28px 24px 64px", display: "flex", flexDirection: "column", gap: 20 },
  card: { background: t.surf, border: `1px solid ${ t.line }`, borderRadius: 16, padding: "18px 20px" },
  label: { fontSize: 12, fontWeight: 600, letterSpacing: 1, color: t.mute, textTransform: "uppercase" },
  h2: { margin: 0, fontSize: 18, fontWeight: 600 },
  mono: { fontFamily: MONO },
  input: { padding: "9px 10px", borderRadius: 8, border: `1px solid ${ t.line }`, background: t.surf, color: t.ink, font: "inherit", fontSize: 14, outline: "none", maxWidth: "100%" },
  btn: ( variant ) => ( {
    padding: "9px 14px", borderRadius: 10, font: "inherit", fontSize: 14, cursor: "pointer",
    border: `1px solid ${ t.line }`, background: t.surf, color: t.ink,
    ...( variant === "primary" ? { background: t.acc, color: t.onAcc, border: "none", fontWeight: 600 }
      : variant === "danger" ? { background: t.clnBg, color: t.clnInk, border: "none", fontWeight: 600 }
        : variant === "dashed" ? { background: "transparent", border: `1.5px dashed ${ t.mute }` } : {} ),
  } ),
  pill: ( on ) => ( {
    padding: "7px 11px", borderRadius: 8, font: "inherit", fontSize: 13, cursor: "pointer",
    border: `1px solid ${ on ? t.acc : t.line }`, background: on ? t.acc : t.surf, color: on ? t.onAcc : t.ink, fontWeight: on ? 600 : 400,
  } ),
  seg: { display: "flex", flexWrap: "wrap", gap: 4, padding: 4, borderRadius: 12, background: t.surf, border: `1px solid ${ t.line }` },
  segBtn: ( on ) => ( {
    padding: "9px 14px", border: "none", borderRadius: 9, font: "inherit", fontSize: 14, cursor: "pointer",
    fontWeight: on ? 600 : 400, background: on ? t.acc : "transparent", color: on ? t.onAcc : t.ink,
  } ),
  navBtn: ( on ) => ( {
    padding: "10px 14px", borderRadius: 10, border: "none", font: "inherit", fontSize: 14, cursor: "pointer",
    background: on ? t.accSoft : "transparent", color: on ? t.accInk : t.mute, fontWeight: on ? 600 : 400,
  } ),
  chip: ( cat ) => ( { background: t[ cat + "Bg" ], color: t[ cat + "Ink" ] } ),
  code: { fontFamily: MONO, fontSize: 13, lineHeight: 1.6, background: t.codeBg, color: t.ink, borderRadius: 10, padding: 12, margin: 0, whiteSpace: "pre-wrap", overflowX: "auto" },
  th: { padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 12, color: t.mute, borderBottom: `1px solid ${ t.line }`, position: "sticky", top: 0, background: t.surf, whiteSpace: "nowrap" },
  td: { padding: "7px 12px", borderBottom: `1px solid ${ t.line }`, whiteSpace: "nowrap" },
  tag: ( type ) => ( {
    display: "inline-block", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: MONO,
    ...( type === "number" ? { background: t.cmbBg, color: t.cmbInk } : type === "date" ? { background: t.rowsBg, color: t.rowsInk } : { background: t.soft, color: t.mute } ),
  } ),
} );

const ThemeCtx = createContext( null );
const useTheme = () => useContext( ThemeCtx );

// -- Step catalogue: [label, category, description, functional idea] --

const STEP_META = {
  filter: [ "Filter", "rows", "Keep rows that pass a test", "higher-order: filter" ],
  sort: [ "Sort", "rows", "Order rows by a column", "copy, then sort" ],
  top_n: [ "Top / Bottom N", "rows", "Keep the N largest or smallest", "sort + slice" ],
  sample: [ "Sample", "rows", "A random subset of rows", "shuffle a copy" ],
  distinct: [ "Distinct", "rows", "Remove duplicate rows", "fold into a Set" ],
  compute: [ "Compute", "cols", "Add a calculated column", "map + spread" ],
  rename: [ "Rename", "cols", "Change a column name", "destructuring" ],
  drop: [ "Drop columns", "cols", "Remove columns", "rest pattern" ],
  cast_type: [ "Cast type", "cols", "Change a column type", "map" ],
  group_aggregate: [ "Group + Aggregate", "sum", "Fold rows into groups", "fold: reduce" ],
  pivot: [ "Pivot", "sum", "Turn values into columns", "fold: reduce" ],
  unpivot: [ "Unpivot", "sum", "Turn columns into rows", "flatMap" ],
  window: [ "Window", "sum", "Running totals, ranks, lag, lead", "scan" ],
  join: [ "Join", "cmb", "Match rows from another source", "hash index + flatMap" ],
  union: [ "Union", "cmb", "Stack another source below", "concat" ],
  fill_null: [ "Fill null", "cln", "Replace empty values", "map" ],
};

const STEP_GROUPS = [ [ "rows", "Shape rows" ], [ "cols", "Shape columns" ], [ "sum", "Summarize" ], [ "cmb", "Combine" ], [ "cln", "Clean" ] ];

const stepMeta = ( step ) => STEP_META[ step.type ] || [ step.type, "rows", "", "pure step" ];

const colsOf = ( rows ) => ( rows && rows.length ? Object.keys( rows[ 0 ] ) : [] );

// Sensible defaults so a new step has a visible effect straight away
const defaultStep = ( type, rows, sourceNames, activeSource ) =>
{
  const cols = colsOf( rows );
  const nums = cols.filter( ( c ) => typeof rows[ 0 ][ c ] === "number" );
  const texts = cols.filter( ( c ) => !nums.includes( c ) );
  // prefer a measure over year-like or id-like numbers for sorting and aggregating
  const measure = nums.find( ( c ) => !/year|date|^id$|_id$/i.test( c ) ) || nums[ 0 ];
  const c0 = cols[ 0 ] || "", n0 = measure || c0, t0 = texts[ 0 ] || c0;
  const other = sourceNames.find( ( n ) => n !== activeSource ) || "";
  const defaults = {
    filter: { column: c0, operator: "equals", value: "" },
    sort: { column: n0, direction: "desc" },
    top_n: { column: n0, direction: "top", n: 10 },
    sample: { n: 10 },
    distinct: { columns: [] },
    compute: { newColumn: "new_column", expression: n0 },
    rename: { column: c0, newName: `${ c0 }_renamed` },
    drop: { columns: [] },
    cast_type: { column: c0, targetType: "string" },
    group_aggregate: { groupColumns: t0 ? [ t0 ] : [], aggregations: [ { column: n0, fn: "sum" } ] },
    pivot: { rowColumn: t0, pivotColumn: texts[ 1 ] || c0, valueColumn: n0 },
    unpivot: { idColumns: t0 ? [ t0 ] : [], nameColumn: "variable", valueColumnName: "value" },
    window: { windowFn: "running_sum", column: n0, orderColumn: "", newColumn: "" },
    join: { joinType: "inner", rightSource: other, leftKey: c0, rightKey: c0 },
    union: { unionSource: other },
    fill_null: { column: c0, strategy: "value", fillValue: "0" },
  };
  return { type, ...( defaults[ type ] || {} ) };
};

// One-line human summary of a step
const stepSummary = ( s ) =>
{
  const list = ( a ) => ( a || [] ).join( ", " ) || "none";
  switch ( s.type )
  {
    case "filter": return s.column && s.value !== "" && s.value !== undefined ? `${ s.column } ${ ( s.operator || "equals" ).replace( /_/g, " " ) } ${ s.value }` : "set a condition";
    case "sort": return `${ s.column || "?" } ${ s.direction || "asc" }`;
    case "top_n": return `${ s.direction === "bottom" ? "bottom" : "top" } ${ s.n || 10 } by ${ s.column || "?" }`;
    case "sample": return `${ s.n || 10 } random rows`;
    case "distinct": return `on ${ ( s.columns || [] ).length ? list( s.columns ) : "all columns" }`;
    case "compute": return `${ s.newColumn || "computed" } = ${ s.expression || "?" }`;
    case "rename": return `${ s.column || "?" } to ${ s.newName || "?" }`;
    case "drop": return list( s.columns );
    case "cast_type": return `${ s.column || "?" } to ${ s.targetType || "string" }`;
    case "group_aggregate": return `by ${ list( s.groupColumns ) }: ${ ( s.aggregations || [] ).map( ( a ) => `${ a.fn }(${ a.column })` ).join( ", " ) || "no aggregates" }`;
    case "pivot": return `${ s.rowColumn || "?" } x ${ s.pivotColumn || "?" }`;
    case "unpivot": return `keep ${ list( s.idColumns ) }`;
    case "window": return `${ ( s.windowFn || "running_sum" ).replace( /_/g, " " ) }(${ s.column || "?" })`;
    case "join": return `${ s.joinType || "inner" } ${ s.rightSource || "?" } on ${ s.leftKey || "?" } = ${ s.rightKey || "?" }`;
    case "union": return `with ${ s.unionSource || "?" }`;
    case "fill_null": return `${ s.column || "?" } (${ s.strategy || "value" })`;
    default: return s.type;
  }
};

// One-line functional JS equivalent of a step
const stepSnippet = ( s ) =>
{
  const lit = ( v ) => ( v === "" || v === undefined || isNaN( Number( v ) ) ? JSON.stringify( String( v ?? "" ) ) : v );
  const strs = ( a ) => ( a || [] ).map( ( c ) => `"${ c }"` ).join( ", " );
  const cmp = { equals: "===", not_equals: "!==", greater_than: ">", less_than: "<" };
  switch ( s.type )
  {
    case "filter": return cmp[ s.operator ] ? `rows.filter(r => r.${ s.column } ${ cmp[ s.operator ] } ${ lit( s.value ) })` : `rows.filter(r => ${ s.operator }(r.${ s.column }, ${ lit( s.value ) }))`;
    case "sort": return `[...rows].sort(by("${ s.column }", "${ s.direction || "asc" }"))`;
    case "top_n": return `[...rows].sort(by("${ s.column }", "${ s.direction === "bottom" ? "asc" : "desc" }")).slice(0, ${ s.n || 10 })`;
    case "sample": return `shuffle([...rows]).slice(0, ${ s.n || 10 })`;
    case "distinct": return `uniqBy(rows, [${ strs( s.columns ) }])`;
    case "compute": return `rows.map(r => ({ ...r, ${ s.newColumn || "computed" }: ${ s.expression || "0" } }))`;
    case "rename": return `rows.map(({ ${ s.column }, ...rest }) => ({ ...rest, ${ s.newName || s.column }: ${ s.column } }))`;
    case "drop": return `rows.map(({ ${ ( s.columns || [] ).join( ", " ) }, ...rest }) => rest)`;
    case "cast_type": return `rows.map(r => ({ ...r, ${ s.column }: ${ { number: "Number", boolean: "Boolean" }[ s.targetType ] || "String" }(r.${ s.column }) }))`;
    case "group_aggregate": return `groupBy(rows, [${ strs( s.groupColumns ) }]).map(aggregate)`;
    case "pivot": return `rows.reduce(toWide("${ s.rowColumn }", "${ s.pivotColumn }", "${ s.valueColumn }"), {})`;
    case "unpivot": return `rows.flatMap(r => toLong(r, [${ strs( s.idColumns ) }]))`;
    case "window": return `scan(rows, ${ s.windowFn || "running_sum" }("${ s.column }"))`;
    case "join": return `rows.flatMap(l => index(${ s.rightSource }).get(l.${ s.leftKey }) ?? [])`;
    case "union": return `[...rows, ...sources.${ s.unionSource }]`;
    case "fill_null": return `rows.map(r => ({ ...r, ${ s.column }: r.${ s.column } ?? ${ lit( s.fillValue ) } }))`;
    default: return `${ s.type }(rows)`;
  }
};

// -- SVG Plan Renderer --

const PlanSVG = ( { logicalNodes, physicalNodes, optimizerRules, width = 900 } ) =>
{
  const { t, S } = useTheme();
  const nodeH = 50;
  const nodeW = 260;
  const gapY = 30;
  const startY = 26;
  const colLogical = 80;
  const colPhysical = width - nodeW - 80;
  const totalH = startY + logicalNodes.length * ( nodeH + gapY ) + 60;
  const svgRef = useRef( null );

  const exportSVG = () =>
  {
    if ( !svgRef.current ) return;
    const svgData = new XMLSerializer().serializeToString( svgRef.current );
    const blob = new Blob( [ svgData ], { type: "image/svg+xml" } );
    const url = URL.createObjectURL( blob );
    const a = document.createElement( "a" );
    a.href = url;
    a.download = "prism-query-plan.svg";
    a.click();
    URL.revokeObjectURL( url );
  };

  return (
    <div>
      <div style={ { display: "flex", justifyContent: "flex-end", marginBottom: 8 } }>
        <button style={ S.btn() } onClick={ exportSVG }>Export SVG</button>
      </div>
      <div style={ { overflowX: "auto", border: `1px solid ${ t.line }`, borderRadius: 12, background: t.soft } }>
        <svg ref={ svgRef } width={ width } height={ totalH } xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Logical and physical query plan" style={ { display: "block" } }>
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M 0 0 L 8 3 L 0 6 Z" fill={ t.mute } />
            </marker>
          </defs>
          <text x={ colLogical + nodeW / 2 } y={ 16 } textAnchor="middle" fill={ t.colsInk } fontSize="11" fontWeight="600" fontFamily={ MONO }>LOGICAL PLAN</text>
          <text x={ colPhysical + nodeW / 2 } y={ 16 } textAnchor="middle" fill={ t.cmbInk } fontSize="11" fontWeight="600" fontFamily={ MONO }>PHYSICAL PLAN</text>

          { logicalNodes.map( ( node, i ) =>
          {
            const y = startY + i * ( nodeH + gapY );
            const phys = physicalNodes[ i ];
            return (
              <g key={ node.id }>
                <rect x={ colLogical } y={ y } width={ nodeW } height={ nodeH } rx={ 10 } fill={ t.colsBg } stroke={ t.colsInk } strokeWidth="1" />
                <text x={ colLogical + 12 } y={ y + 20 } fill={ t.ink } fontSize="12" fontWeight="600" fontFamily={ MONO }>{ node.label }</text>
                <text x={ colLogical + 12 } y={ y + 38 } fill={ t.mute } fontSize="10" fontFamily={ MONO }>{ ( node.details || "" ).substring( 0, 38 ) }</text>

                <rect x={ colPhysical } y={ y } width={ nodeW } height={ nodeH } rx={ 10 } fill={ t.surf } stroke={ t.cmbInk } strokeWidth="1" />
                <text x={ colPhysical + 12 } y={ y + 20 } fill={ t.cmbInk } fontSize="12" fontWeight="600" fontFamily={ MONO }>{ phys.label }</text>
                <text x={ colPhysical + 12 } y={ y + 38 } fill={ t.mute } fontSize="9" fontFamily={ MONO }>{ ( phys.physicalOp || "" ).substring( 0, 42 ) }</text>

                <line x1={ colLogical + nodeW } y1={ y + nodeH / 2 } x2={ colPhysical } y2={ y + nodeH / 2 } stroke={ t.mute } strokeWidth="1" strokeDasharray="4 3" />

                { i < logicalNodes.length - 1 && (
                  <line x1={ colLogical + nodeW / 2 } y1={ y + nodeH } x2={ colLogical + nodeW / 2 } y2={ y + nodeH + gapY } stroke={ t.mute } strokeWidth="1.5" markerEnd="url(#arrowhead)" />
                ) }
                { i < physicalNodes.length - 1 && (
                  <line x1={ colPhysical + nodeW / 2 } y1={ y + nodeH } x2={ colPhysical + nodeW / 2 } y2={ y + nodeH + gapY } stroke={ t.mute } strokeWidth="1.5" markerEnd="url(#arrowhead)" />
                ) }
              </g>
            );
          } ) }

          { optimizerRules.length > 0 && (
            <g>
              <text x={ width / 2 } y={ totalH - 40 } textAnchor="middle" fill={ t.rowsInk } fontSize="11" fontWeight="600" fontFamily={ MONO }>
                OPTIMIZER ({ optimizerRules.length } rule{ optimizerRules.length !== 1 ? "s" : "" } applied)
              </text>
              { optimizerRules.slice( 0, 3 ).map( ( rule, i ) => (
                <text key={ i } x={ width / 2 } y={ totalH - 24 + i * 14 } textAnchor="middle" fill={ t.mute } fontSize="9" fontFamily={ MONO }>
                  { rule.rule }: { rule.desc }
                </text>
              ) ) }
            </g>
          ) }
        </svg>
      </div>
    </div>
  );
};

// -- Chart rendering --

const ChartRenderer = ( { config, data, height = 300 } ) =>
{
  const { t } = useTheme();
  const empty = ( msg ) => <div style={ { padding: 40, textAlign: "center", color: t.mute, fontSize: 14 } }>{ msg }</div>;
  if ( !data || !data.length || !config.type ) return empty( "Configure chart dimensions to render a visualization." );

  const xKey = config.xColumn;
  const yKeys = config.yColumns || [];
  if ( !xKey || yKeys.length === 0 ) return empty( "Pick an X axis and at least one Y axis column." );

  const colors = t.series;
  const chartData = data.map( ( row ) =>
  {
    const d = { ...row };
    yKeys.forEach( ( k ) => { d[ k ] = Number( row[ k ] ) || 0; } );
    return d;
  } );

  const commonProps = { data: chartData, margin: { top: 10, right: 30, left: 10, bottom: 30 } };
  const axisStyle = { fontSize: 11, fill: t.mute };
  const gridStyle = { strokeDasharray: "3 3", stroke: t.line };
  const tooltip = <Tooltip contentStyle={ { background: t.surf, border: `1px solid ${ t.line }`, borderRadius: 8, fontSize: 12, color: t.ink } } cursor={ { fill: t.soft } } />;
  const legend = <Legend wrapperStyle={ { fontSize: 12, color: t.ink } } />;

  switch ( config.type )
  {
    case "bar":
    case "stacked_bar":
    case "grouped_bar":
    case "horizontal_bar":
      if ( config.type === "horizontal_bar" )
      {
        return (
          <ResponsiveContainer width="100%" height={ height }>
            <BarChart { ...commonProps } layout="vertical">
              <CartesianGrid { ...gridStyle } />
              <XAxis type="number" tick={ axisStyle } />
              <YAxis dataKey={ xKey } type="category" tick={ axisStyle } width={ 100 } />
              { tooltip }{ legend }
              { yKeys.map( ( k, i ) => <Bar key={ k } dataKey={ k } fill={ colors[ i % colors.length ] } radius={ [ 0, 6, 6, 0 ] } /> ) }
            </BarChart>
          </ResponsiveContainer>
        );
      }
      return (
        <ResponsiveContainer width="100%" height={ height }>
          <BarChart { ...commonProps }>
            <CartesianGrid { ...gridStyle } />
            <XAxis dataKey={ xKey } tick={ axisStyle } />
            <YAxis tick={ axisStyle } />
            { tooltip }{ legend }
            { yKeys.map( ( k, i ) => <Bar key={ k } dataKey={ k } fill={ colors[ i % colors.length ] } stackId={ config.type === "stacked_bar" ? "stack" : undefined } radius={ config.type === "stacked_bar" ? 0 : [ 6, 6, 0, 0 ] } /> ) }
          </BarChart>
        </ResponsiveContainer>
      );
    case "line":
      return (
        <ResponsiveContainer width="100%" height={ height }>
          <LineChart { ...commonProps }>
            <CartesianGrid { ...gridStyle } />
            <XAxis dataKey={ xKey } tick={ axisStyle } />
            <YAxis tick={ axisStyle } />
            { tooltip }{ legend }
            { yKeys.map( ( k, i ) => <Line key={ k } type="monotone" dataKey={ k } stroke={ colors[ i % colors.length ] } strokeWidth={ 3 } dot={ { r: 3 } } /> ) }
          </LineChart>
        </ResponsiveContainer>
      );
    case "area":
      return (
        <ResponsiveContainer width="100%" height={ height }>
          <AreaChart { ...commonProps }>
            <CartesianGrid { ...gridStyle } />
            <XAxis dataKey={ xKey } tick={ axisStyle } />
            <YAxis tick={ axisStyle } />
            { tooltip }{ legend }
            { yKeys.map( ( k, i ) => <Area key={ k } type="monotone" dataKey={ k } stroke={ colors[ i % colors.length ] } strokeWidth={ 2 } fill={ colors[ i % colors.length ] } fillOpacity={ 0.3 } /> ) }
          </AreaChart>
        </ResponsiveContainer>
      );
    case "scatter":
      return (
        <ResponsiveContainer width="100%" height={ height }>
          <ScatterChart { ...commonProps }>
            <CartesianGrid { ...gridStyle } />
            <XAxis dataKey={ xKey } name={ xKey } tick={ axisStyle } />
            <YAxis dataKey={ yKeys[ 0 ] } name={ yKeys[ 0 ] } tick={ axisStyle } />
            { tooltip }
            <Scatter data={ chartData } fill={ colors[ 0 ] } />
          </ScatterChart>
        </ResponsiveContainer>
      );
    case "pie":
    case "donut":
      return (
        <ResponsiveContainer width="100%" height={ height }>
          <PieChart>
            <Pie
              data={ chartData }
              dataKey={ yKeys[ 0 ] }
              nameKey={ xKey }
              cx="50%"
              cy="50%"
              outerRadius={ config.type === "donut" ? 110 : 120 }
              innerRadius={ config.type === "donut" ? 60 : 0 }
              label={ ( { name, value } ) => `${ name }: ${ value }` }
              labelLine={ { stroke: t.mute } }
              fontSize={ 11 }
              stroke={ t.surf }
            >
              { chartData.map( ( _, i ) => <Cell key={ i } fill={ colors[ i % colors.length ] } /> ) }
            </Pie>
            { tooltip }
          </PieChart>
        </ResponsiveContainer>
      );
    default:
      return empty( "Unknown chart type." );
  }
};

const chartTitle = ( c ) => ( c.xColumn && ( c.yColumns || [] ).length ? `${ c.yColumns.join( ", " ) } by ${ c.xColumn }` : "Chart preview" );

// -- Small building blocks --

const PageTitle = ( { title, sub, children } ) =>
{
  const { t } = useTheme();
  return (
    <div style={ { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16 } }>
      <div style={ { flex: "1 1 480px" } }>
        <h1 style={ { margin: 0, fontSize: 28, fontWeight: 700 } }>{ title }</h1>
        { sub && <p style={ { margin: "6px 0 0", color: t.mute, fontSize: 15 } }>{ sub }</p> }
      </div>
      { children && <div style={ { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" } }>{ children }</div> }
    </div>
  );
};

const EmptyCard = ( { children, action, onAction } ) =>
{
  const { t, S } = useTheme();
  return (
    <div style={ { ...S.card, textAlign: "center", color: t.mute, padding: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, fontSize: 15 } }>
      <span>{ children }</span>
      { action && <button style={ S.btn( "primary" ) } onClick={ onAction }>{ action }</button> }
    </div>
  );
};

const Badge = ( { cat, num, size = 32 } ) =>
{
  const { S } = useTheme();
  return (
    <span style={ { ...S.chip( cat ), width: size, height: size, borderRadius: 9, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } }>{ num }</span>
  );
};

const RowBar = ( { pct, color, height = 6 } ) =>
{
  const { t } = useTheme();
  return (
    <span style={ { display: "block", width: "100%", height, borderRadius: height / 2, background: t.soft } }>
      <span style={ { display: "block", height, width: `${ Math.max( 2, Math.min( 100, pct ) ) }%`, borderRadius: height / 2, background: color } } />
    </span>
  );
};

const FlowLink = ( { count, onInsert } ) =>
{
  const { t, S } = useTheme();
  return (
    <div style={ { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 } }>
      <span style={ { ...S.mono, fontSize: 12, fontWeight: 500 } }>{ count }</span>
      <span style={ { display: "block", width: 40, height: 2, background: t.mute } } />
      { onInsert && (
        <button aria-label="Insert a step here" title="Insert a step here" onClick={ onInsert } style={ { width: 32, height: 32, borderRadius: 16, border: `1px dashed ${ t.mute }`, background: t.surf, color: t.ink, font: "inherit", fontSize: 17, lineHeight: 1, padding: 0, cursor: "pointer" } }>+</button>
      ) }
    </div>
  );
};

const InsertRow = ( { label, onInsert } ) =>
{
  const { t, S } = useTheme();
  return (
    <div style={ { display: "flex", alignItems: "center", gap: 12, padding: "6px 0 6px 40px" } }>
      <span style={ { display: "block", width: 2, height: 34, background: t.line } } />
      <span style={ { fontSize: 12, color: t.mute } }>{ label }</span>
      { onInsert && <button style={ { ...S.btn( "dashed" ), padding: "7px 12px", fontSize: 12 } } onClick={ onInsert }>+ insert step here</button> }
    </div>
  );
};

const Field = ( { label, children } ) =>
{
  const { t } = useTheme();
  return (
    <div style={ { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 } }>
      <span style={ { fontSize: 12, fontWeight: 600, color: t.mute } }>{ label }</span>
      { children }
    </div>
  );
};

// Pills for short option lists (visible choices), a select for long ones
const Choice = ( { value, options, onChange, labels = {}, label } ) =>
{
  const { S } = useTheme();
  const opts = value && !options.includes( value ) ? [ value, ...options ] : options;
  if ( opts.length > 10 )
  {
    return (
      <select aria-label={ label } style={ S.input } value={ value || "" } onChange={ ( e ) => onChange( e.target.value ) }>
        { !value && <option value="">choose</option> }
        { opts.map( ( o ) => <option key={ o } value={ o }>{ labels[ o ] || o }</option> ) }
      </select>
    );
  }
  return (
    <div role="group" aria-label={ label } style={ { display: "flex", flexWrap: "wrap", gap: 4 } }>
      { opts.map( ( o ) => <button key={ o } aria-pressed={ o === value } style={ S.pill( o === value ) } onClick={ () => onChange( o ) }>{ labels[ o ] || o }</button> ) }
    </div>
  );
};

const MultiChoice = ( { values, options, onChange, danger, label } ) =>
{
  const { t, S } = useTheme();
  return (
    <div role="group" aria-label={ label } style={ { display: "flex", flexWrap: "wrap", gap: 4 } }>
      { options.map( ( o ) =>
      {
        const on = values.includes( o );
        const style = on && danger
          ? { ...S.pill( false ), background: t.clnBg, color: t.clnInk, border: `1px solid ${ t.clnInk }`, fontWeight: 600, textDecoration: "line-through" }
          : S.pill( on );
        return <button key={ o } aria-pressed={ on } style={ style } onClick={ () => onChange( on ? values.filter( ( x ) => x !== o ) : [ ...values, o ] ) }>{ o }</button>;
      } ) }
    </div>
  );
};

const DataTable = ( { data, maxRows = 100, maxHeight = 400, highlight = {} } ) =>
{
  const { t, S } = useTheme();
  if ( !data || !data.length ) return <div style={ { color: t.mute, padding: 16, fontSize: 13 } }>No rows.</div>;
  const columns = Object.keys( data[ 0 ] );
  const hl = ( c ) => ( highlight[ c ] ? { background: highlight[ c ], color: t.ink } : {} );
  return (
    <div>
      <div style={ { overflow: "auto", maxHeight, borderRadius: 10, border: `1px solid ${ t.line }` } }>
        <table style={ { width: "100%", borderCollapse: "collapse", fontSize: 13 } }>
          <thead>
            <tr>{ columns.map( ( c ) => <th key={ c } style={ { ...S.th, ...hl( c ) } }>{ c }</th> ) }</tr>
          </thead>
          <tbody>
            { data.slice( 0, maxRows ).map( ( row, i ) => (
              <tr key={ i }>
                { columns.map( ( c ) => (
                  <td key={ c } style={ { ...S.td, ...hl( c ) } }>
                    { row[ c ] === null || row[ c ] === undefined ? <span style={ { color: t.mute, fontStyle: "italic" } }>null</span> : String( row[ c ] ) }
                  </td>
                ) ) }
              </tr>
            ) ) }
          </tbody>
        </table>
      </div>
      { data.length > maxRows && <div style={ { marginTop: 6, color: t.mute, fontSize: 12 } }>Showing { maxRows } of { data.length } rows</div> }
    </div>
  );
};

const ColumnStats = ( { data } ) =>
{
  const { t, S } = useTheme();
  if ( !data || !data.length ) return null;
  const columns = Object.keys( data[ 0 ] );
  return (
    <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>
      { columns.map( ( c ) =>
      {
        const values = data.map( ( r ) => r[ c ] );
        const type = inferType( values );
        const st = computeStats( values, type );
        const detail = type === "number" ? `${ st.min } to ${ st.max }, mean ${ st.mean }`
          : type === "date" ? `${ st.earliest } to ${ st.latest }` : `${ st.uniqueCount } unique`;
        return (
          <div key={ c } style={ { padding: "10px 12px", borderRadius: 10, background: t.soft, display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 } }>
            <span style={ { display: "flex", alignItems: "center", gap: 8 } }><strong>{ c }</strong><span style={ S.tag( type ) }>{ type }</span></span>
            <span style={ { color: t.mute } }>{ detail }</span>
          </div>
        );
      } ) }
    </div>
  );
};

const StepLibrary = ( { title, onPick, onCancel } ) =>
{
  const { t, S } = useTheme();
  return (
    <section aria-label="Choose a step" style={ { ...S.card, border: `2px solid ${ t.acc }`, display: "flex", flexDirection: "column", gap: 16 } }>
      <div style={ { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 } }>
        <h2 style={ { margin: 0, fontSize: 19, fontWeight: 700 } }>{ title }</h2>
        <button style={ S.btn() } onClick={ onCancel }>Cancel</button>
      </div>
      <div style={ { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 16 } }>
        { STEP_GROUPS.map( ( [ cat, name ] ) => (
          <div key={ cat } style={ { display: "flex", flexDirection: "column", gap: 6 } }>
            <span style={ { ...S.label, color: t[ cat + "Ink" ] } }>{ name }</span>
            { Object.entries( STEP_META ).filter( ( [ , m ] ) => m[ 1 ] === cat ).map( ( [ type, m ] ) => (
              <button key={ type } onClick={ () => onPick( type ) } style={ { textAlign: "left", padding: "10px 12px", borderRadius: 10, border: "none", cursor: "pointer", font: "inherit", background: t[ cat + "Bg" ], color: t.ink, display: "flex", flexDirection: "column", gap: 2 } }>
                <span style={ { fontSize: 14, fontWeight: 600 } }>{ m[ 0 ] }</span>
                <span style={ { fontSize: 12, opacity: 0.8 } }>{ m[ 2 ] }</span>
              </button>
            ) ) }
          </div>
        ) ) }
      </div>
    </section>
  );
};

// Settings form for each transform type
const StepEditor = ( { step, columns, sources, activeSource, onUpdate } ) =>
{
  const { t, S } = useTheme();
  const u = ( field ) => ( value ) => onUpdate( { [ field ]: value } );
  const pick = ( label, field, options, labels ) => (
    <Field label={ label }><Choice label={ label } value={ step[ field ] ?? "" } options={ options } labels={ labels } onChange={ u( field ) } /></Field>
  );
  const multi = ( label, field, options, danger ) => (
    <Field label={ label }><MultiChoice label={ label } values={ step[ field ] || [] } options={ options } danger={ danger } onChange={ u( field ) } /></Field>
  );
  const text = ( label, field, placeholder, width = 160 ) => (
    <Field label={ label }><input aria-label={ label } style={ { ...S.input, width } } placeholder={ placeholder } value={ step[ field ] ?? "" } onChange={ ( e ) => u( field )( e.target.value ) } /></Field>
  );
  const num = ( label, field, fallback ) => (
    <Field label={ label }><input aria-label={ label } type="number" min="1" style={ { ...S.input, width: 90 } } value={ step[ field ] ?? fallback } onChange={ ( e ) => u( field )( parseInt( e.target.value ) || fallback ) } /></Field>
  );
  const row = ( children ) => <div style={ { display: "flex", flexWrap: "wrap", gap: "12px 18px", alignItems: "flex-end" } }>{ children }</div>;
  const hint = ( msg ) => <span style={ { fontSize: 13, color: t.mute } }>{ msg }</span>;
  const others = Object.keys( sources ).filter( ( n ) => n !== activeSource );

  switch ( step.type )
  {
    case "filter":
      return row( <>
        { pick( "Column", "column", columns ) }
        { pick( "Test", "operator", Object.keys( OPERATORS ), Object.fromEntries( Object.keys( OPERATORS ).map( ( o ) => [ o, o.replace( /_/g, " " ) ] ) ) ) }
        { text( "Value", "value", step.operator === "between" ? "low,high" : "value" ) }
      </> );
    case "sort":
      return row( <>
        { pick( "Column", "column", columns ) }
        { pick( "Order", "direction", [ "asc", "desc" ], { asc: "ascending", desc: "descending" } ) }
      </> );
    case "top_n":
      return row( <>
        { pick( "Keep", "direction", [ "top", "bottom" ], { top: "largest", bottom: "smallest" } ) }
        { num( "How many", "n", 10 ) }
        { pick( "By", "column", columns ) }
      </> );
    case "sample":
      return row( <>{ num( "Rows", "n", 10 ) }{ hint( "Random: a new sample is drawn whenever the pipeline changes." ) }</> );
    case "distinct":
      return <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>{ multi( "Distinct on", "columns", columns ) }{ hint( "None selected means all columns." ) }</div>;
    case "compute":
      return (
        <div style={ { display: "flex", flexDirection: "column", gap: 10 } }>
          { row( <>{ text( "New column", "newColumn", "new column" ) }{ text( "Expression", "expression", "e.g. population * gdp_per_capita / 1e6", 380 ) }</> ) }
          <div style={ { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } }>
            <span style={ { fontSize: 12, color: t.mute, marginRight: 4 } }>Insert column:</span>
            { columns.map( ( c ) => (
              <button key={ c } style={ { ...S.pill( false ), padding: "5px 9px", fontSize: 12 } } onClick={ () => u( "expression" )( `${ step.expression || "" }${ step.expression ? " " : "" }${ c }` ) }>{ c }</button>
            ) ) }
          </div>
        </div>
      );
    case "rename":
      return row( <>{ pick( "Column", "column", columns ) }{ text( "New name", "newName", "new name" ) }</> );
    case "drop":
      return <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>{ multi( "Columns to drop", "columns", columns, true ) }</div>;
    case "cast_type":
      return row( <>{ pick( "Column", "column", columns ) }{ pick( "To", "targetType", [ "string", "number", "boolean" ] ) }</> );
    case "group_aggregate": {
      const aggs = step.aggregations || [];
      const setAgg = ( i, patch ) => u( "aggregations" )( aggs.map( ( a, j ) => ( j === i ? { ...a, ...patch } : a ) ) );
      return (
        <div style={ { display: "flex", flexDirection: "column", gap: 12 } }>
          { multi( "Group by", "groupColumns", columns ) }
          <Field label="Aggregations">
            <div style={ { display: "flex", flexDirection: "column", gap: 6 } }>
              { aggs.map( ( a, i ) => (
                <div key={ i } style={ { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } }>
                  <select aria-label="Aggregate function" style={ S.input } value={ a.fn || "sum" } onChange={ ( e ) => setAgg( i, { fn: e.target.value } ) }>
                    { Object.keys( aggregators ).map( ( fn ) => <option key={ fn } value={ fn }>{ fn }</option> ) }
                  </select>
                  <span style={ { color: t.mute } }>of</span>
                  <select aria-label="Aggregate column" style={ S.input } value={ a.column || "" } onChange={ ( e ) => setAgg( i, { column: e.target.value } ) }>
                    <option value="">column</option>
                    { columns.map( ( c ) => <option key={ c } value={ c }>{ c }</option> ) }
                  </select>
                  <span style={ { ...S.mono, fontSize: 12, color: t.mute } }>as { a.column }_{ a.fn }</span>
                  <button style={ { ...S.btn( "danger" ), padding: "7px 11px", fontSize: 13 } } onClick={ () => u( "aggregations" )( aggs.filter( ( _, j ) => j !== i ) ) }>Remove</button>
                </div>
              ) ) }
              <button style={ { ...S.btn( "dashed" ), alignSelf: "flex-start", fontSize: 13 } } onClick={ () => u( "aggregations" )( [ ...aggs, { column: columns[ 0 ] || "", fn: "sum" } ] ) }>+ aggregation</button>
            </div>
          </Field>
        </div>
      );
    }
    case "pivot":
      return row( <>{ pick( "Row", "rowColumn", columns ) }{ pick( "Pivot", "pivotColumn", columns ) }{ pick( "Value", "valueColumn", columns ) }</> );
    case "unpivot":
      return (
        <div style={ { display: "flex", flexDirection: "column", gap: 12 } }>
          { multi( "ID columns (kept as-is)", "idColumns", columns ) }
          { row( <>{ text( "Name column", "nameColumn", "variable" ) }{ text( "Value column", "valueColumnName", "value" ) }</> ) }
        </div>
      );
    case "window":
      return row( <>
        { pick( "Function", "windowFn", [ "running_sum", "running_avg", "row_number", "rank", "lag", "lead" ], { running_sum: "running sum", running_avg: "running avg", row_number: "row number" } ) }
        { pick( "Of", "column", columns ) }
        { pick( "Order by", "orderColumn", [ "", ...columns ], { "": "none" } ) }
        { text( "Output column", "newColumn", "auto" ) }
      </> );
    case "join": {
      if ( !others.length ) return hint( "Add a second source on the Data page first, then join it here." );
      const rightCols = colsOf( sources[ step.rightSource ] );
      return row( <>
        { pick( "Type", "joinType", [ "inner", "left", "right" ] ) }
        { pick( "Right source", "rightSource", others ) }
        { pick( "Left key", "leftKey", columns ) }
        { rightCols.length ? pick( "Right key", "rightKey", rightCols ) : text( "Right key", "rightKey", "right key" ) }
      </> );
    }
    case "union":
      if ( !others.length ) return hint( "Add a second source on the Data page first, then union it here." );
      return row( <>{ pick( "Union with", "unionSource", others ) }</> );
    case "fill_null":
      return row( <>
        { pick( "Column", "column", columns ) }
        { pick( "Strategy", "strategy", [ "value", "forward", "backward" ], { value: "fixed value", forward: "forward fill", backward: "backward fill" } ) }
        { ( step.strategy || "value" ) === "value" && text( "Fill with", "fillValue", "fill value", 120 ) }
      </> );
    default:
      return null;
  }
};

// -- Main Application --

const MAIN_TABS = [ { key: "data", label: "Data" }, { key: "pipeline", label: "Pipeline" }, { key: "chart", label: "Chart" }, { key: "dashboard", label: "Dashboard" } ];
const HOOD_TABS = [ { key: "code", label: "Code" }, { key: "plan", label: "Plan" } ];
const ENGINE_SHORT = { js: "JavaScript", arrow: "Arrow (concept)", webgpu: "WebGPU", duckdb: "DuckDB" };
const CHART_TYPES = [ "bar", "horizontal_bar", "stacked_bar", "grouped_bar", "line", "area", "scatter", "pie", "donut" ];

export default function Prism ()
{
  const [ palette, setPalette ] = useState( "sorbet" );
  const t = THEMES[ palette ];
  const S = useMemo( () => makeStyles( t ), [ t ] );

  const [ tab, setTab ] = useState( "data" );
  const [ dataSources, setDataSources ] = useState( {} );
  const [ activeSource, setActiveSource ] = useState( "main" );
  const [ dataSource, setDataSource ] = useState( "" );
  const [ csvText, setCsvText ] = useState( "" );
  const [ jsonText, setJsonText ] = useState( "" );
  const [ newSourceName, setNewSourceName ] = useState( "" );
  const [ steps, dispatch ] = useReducer( pipelineReducer, [] );
  const [ chartConfig, setChartConfig ] = useState( { type: "bar", xColumn: "", yColumns: [], colorColumn: "", sizeColumn: "" } );
  const [ dashboardCharts, setDashboardCharts ] = useState( [] );
  const [ pipeView, setPipeView ] = useState( "flow" );
  const [ selectedId, setSelectedId ] = useState( null );
  const [ insertAt, setInsertAt ] = useState( null );
  const [ dragIdx, setDragIdx ] = useState( null );
  const [ engine, setEngine ] = useState( "js" );

  // DuckDB WASM state
  const duckDBRef = useRef( null );
  const [ duckDBStatus, setDuckDBStatus ] = useState( "idle" );
  const [ duckDBError, setDuckDBError ] = useState( null );
  const [ duckDBResult, setDuckDBResult ] = useState( null );
  const [ duckDBPlan, setDuckDBPlan ] = useState( { logical: "", physical: "" } );
  const [ duckDBTiming, setDuckDBTiming ] = useState( null );

  // Current raw data is the active source
  const rawData = dataSources[ activeSource ] || null;
  const hasData = !!( rawData && rawData.length );

  const sourceNames = useMemo( () => Object.keys( dataSources ), [ dataSources ] );

  // Parse incoming data
  const parseAndSetData = useCallback( ( text, format, sourceName ) =>
  {
    try
    {
      const target = sourceName || activeSource;
      if ( format === "csv" )
      {
        const result = Papa.parse( text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: true } );
        if ( result.data && result.data.length > 0 )
        {
          setDataSources( ( prev ) => ( { ...prev, [ target ]: result.data } ) );
          return;
        }
      }
      if ( format === "json" )
      {
        const parsed = JSON.parse( text );
        const arr = Array.isArray( parsed ) ? parsed : [ parsed ];
        setDataSources( ( prev ) => ( { ...prev, [ target ]: arr } ) );
        return;
      }
    } catch ( e )
    {
      console.error( "Parse error:", e );
    }
  }, [ activeSource ] );

  const loadSample = useCallback( ( key ) =>
  {
    const ds = SAMPLE_DATASETS[ key ];
    if ( ds )
    {
      const newSources = {};
      Object.entries( ds.files ).forEach( ( [ fileKey, fileData ] ) =>
      {
        newSources[ fileKey ] = deepClone( fileData.data );
      } );
      setDataSources( newSources );
      setActiveSource( Object.keys( ds.files )[ 0 ] );
      setDataSource( key );
      dispatch( { type: "CLEAR" } );
      setSelectedId( null );
      setInsertAt( null );
      setChartConfig( { type: "bar", xColumn: "", yColumns: [], colorColumn: "", sizeColumn: "" } );
    }
  }, [] );

  const context = useMemo( () => ( { dataSources } ), [ dataSources ] );

  // Run the pipeline once, keeping every intermediate value for previews
  const runs = useMemo( () =>
  {
    if ( !rawData ) return [];
    const out = [];
    steps.reduce( ( rows, step ) =>
    {
      let next = rows;
      if ( step.enabled !== false )
      {
        try { next = applyStep( step, rows, context ); } catch { next = rows; }
      }
      out.push( { step, inRows: rows, outRows: next } );
      return next;
    }, rawData );
    return out;
  }, [ rawData, steps, context ] );

  const transformedData = rawData ? ( runs.length ? runs[ runs.length - 1 ].outRows : rawData ) : null;
  const currentColumns = useMemo( () => colsOf( transformedData || rawData ), [ transformedData, rawData ] );

  const nodes = runs.map( ( r, i ) =>
  {
    const meta = stepMeta( r.step );
    const cat = meta[ 1 ];
    const inCols = colsOf( r.inRows ), outCols = colsOf( r.outRows );
    const off = r.step.enabled === false;
    const dr = r.outRows.length - r.inRows.length, dc = outCols.length - inCols.length;
    const delta = off ? "off" : dr ? `${ dr > 0 ? "+" : "" }${ dr } rows` : dc ? `${ dc > 0 ? "+" : "" }${ dc } col${ Math.abs( dc ) > 1 ? "s" : "" }` : "same shape";
    const highlight = {};
    outCols.filter( ( c ) => !inCols.includes( c ) ).forEach( ( c ) => { highlight[ c ] = t.colsBg; } );
    [ r.step.column, ...( r.step.groupColumns || [] ) ].forEach( ( c ) =>
    {
      if ( c && outCols.includes( c ) && !highlight[ c ] ) highlight[ c ] = t[ cat + "Bg" ];
    } );
    return { ...r, i, meta, cat, off, delta, highlight, inCols, isSel: r.step.id === selectedId };
  } );
  const selNode = nodes.find( ( n ) => n.isSel ) || null;

  // Pipeline editing: every handler produces a new steps array via the reducer
  const addStep = ( type ) =>
  {
    const at = insertAt === null ? steps.length : insertAt;
    const inRows = at === 0 ? rawData : runs[ at - 1 ].outRows;
    const step = { ...defaultStep( type, inRows, sourceNames, activeSource ), id: nextId() };
    dispatch( { type: "ADD_STEP", step, index: at } );
    setSelectedId( step.id );
    setInsertAt( null );
  };
  const removeStep = ( id ) =>
  {
    const i = steps.findIndex( ( s ) => s.id === id );
    const rest = steps.filter( ( s ) => s.id !== id );
    const neighbour = rest[ Math.min( i, rest.length - 1 ) ];
    dispatch( { type: "REMOVE_STEP", id } );
    setSelectedId( neighbour ? neighbour.id : null );
  };
  const moveStep = ( id, delta ) =>
  {
    const i = steps.findIndex( ( s ) => s.id === id );
    const j = i + delta;
    if ( i < 0 || j < 0 || j >= steps.length ) return;
    dispatch( { type: "REORDER", from: i, to: j } );
  };
  const updateStep = ( id ) => ( updates ) => dispatch( { type: "UPDATE_STEP", id, updates } );
  const toggleStep = ( id ) => dispatch( { type: "TOGGLE_STEP", id } );

  const handleDrop = ( e, idx ) =>
  {
    e.preventDefault();
    if ( dragIdx !== null && dragIdx !== idx ) dispatch( { type: "REORDER", from: dragIdx, to: idx } );
    setDragIdx( null );
  };

  const handleMultiFileUpload = ( e ) =>
  {
    const files = Array.from( e.target.files );
    files.forEach( ( file ) =>
    {
      const name = file.name.replace( /\.[^.]+$/, "" );
      const reader = new FileReader();
      reader.onload = ( ev ) =>
      {
        parseAndSetData( ev.target.result, "csv", name );
      };
      reader.readAsText( file );
    } );
    if ( files.length > 0 ) setActiveSource( files[ 0 ].name.replace( /\.[^.]+$/, "" ) );
  };

  const createSource = () =>
  {
    const name = newSourceName.trim();
    if ( !name ) return;
    setDataSources( ( prev ) => ( { ...prev, [ name ]: [] } ) );
    setActiveSource( name );
    setNewSourceName( "" );
  };

  // Dashboard operations
  const addChartToDashboard = () =>
  {
    const chart = { id: Date.now(), config: { ...chartConfig }, steps: deepClone( steps ), width: 1, height: 1 };
    setDashboardCharts( ( prev ) => [ ...prev, chart ] );
  };

  const removeChartFromDashboard = ( id ) =>
  {
    setDashboardCharts( ( prev ) => prev.filter( ( c ) => c.id !== id ) );
  };

  // Save / Load
  const saveDashboard = () =>
  {
    const payload = { dataSources, activeSource, steps, charts: dashboardCharts, chartConfig, engine };
    const blob = new Blob( [ JSON.stringify( payload, null, 2 ) ], { type: "application/json" } );
    const url = URL.createObjectURL( blob );
    const a = document.createElement( "a" );
    a.href = url;
    a.download = "prism-v4-dashboard.json";
    a.click();
    URL.revokeObjectURL( url );
  };

  const loadDashboard = ( e ) =>
  {
    const file = e.target.files[ 0 ];
    if ( !file ) return;
    const reader = new FileReader();
    reader.onload = ( ev ) =>
    {
      try
      {
        const payload = JSON.parse( ev.target.result );
        if ( payload.dataSources ) setDataSources( payload.dataSources );
        if ( payload.activeSource ) setActiveSource( payload.activeSource );
        if ( payload.steps ) dispatch( { type: "LOAD", steps: payload.steps } );
        if ( payload.charts ) setDashboardCharts( payload.charts );
        if ( payload.chartConfig ) setChartConfig( payload.chartConfig );
        if ( payload.engine ) setEngine( payload.engine );
        setSelectedId( null );
        setInsertAt( null );
      } catch ( err )
      {
        console.error( "Failed to load dashboard:", err );
      }
    };
    reader.readAsText( file );
  };

  const code = useMemo( () => generateCode( steps, chartConfig, engine ), [ steps, chartConfig, engine ] );

  // Query plan data
  const logicalNodes = useMemo( () =>
  {
    return buildLogicalPlan( steps, activeSource, rawData ? rawData.length : 0 );
  }, [ steps, activeSource, rawData ] );

  const optimized = useMemo( () => optimizePipeline( steps ), [ steps ] );

  const physicalNodes = useMemo( () =>
  {
    return buildPhysicalPlan( logicalNodes, engine );
  }, [ logicalNodes, engine ] );

  // DuckDB: initialize when engine switches to "duckdb"
  useEffect( () =>
  {
    if ( engine !== "duckdb" ) return;
    if ( duckDBRef.current ) { setDuckDBStatus( "ready" ); return; }
    let cancelled = false;
    setDuckDBStatus( "loading" );
    setDuckDBError( null );
    ( async () =>
    {
      try
      {
        const mod = await import( "@duckdb/duckdb-wasm" );
        const bundles = mod.getJsDelivrBundles();
        const bundle = await mod.selectBundle( bundles );
        const workerUrl = URL.createObjectURL(
          new Blob( [ `importScripts("${ bundle.mainWorker }");` ], { type: "text/javascript" } )
        );
        const worker = new Worker( workerUrl );
        const db = new mod.AsyncDuckDB( new mod.ConsoleLogger(), worker );
        await db.instantiate( bundle.mainModule, bundle.pthreadWorker );
        URL.revokeObjectURL( workerUrl );
        if ( !cancelled ) { duckDBRef.current = db; setDuckDBStatus( "ready" ); }
      } catch ( err )
      {
        if ( !cancelled ) { setDuckDBError( err.message ); setDuckDBStatus( "error" ); }
      }
    } )();
    return () => { cancelled = true; };
  }, [ engine ] );

  // DuckDB: load data and execute pipeline when ready
  useEffect( () =>
  {
    if ( engine !== "duckdb" || duckDBStatus !== "ready" || !rawData || !rawData.length ) return;
    let cancelled = false;
    ( async () =>
    {
      try
      {
        const db = duckDBRef.current;
        const conn = await db.connect();
        // load all data sources as tables
        for ( const [ name, data ] of Object.entries( dataSources ) )
        {
          if ( !data || !data.length ) continue;
          const cols = Object.keys( data[ 0 ] );
          const colDefs = cols.map( c =>
          {
            const sample = data.find( r => r[ c ] !== null && r[ c ] !== undefined && r[ c ] !== "" );
            const val = sample ? sample[ c ] : "";
            return `${ qid( c ) } ${ typeof val === "number" ? "DOUBLE" : "VARCHAR" }`;
          } ).join( ", " );
          await conn.query( `DROP TABLE IF EXISTS ${ qid( name ) }` );
          await conn.query( `CREATE TABLE ${ qid( name ) } (${ colDefs })` );
          // insert in batches
          for ( let i = 0; i < data.length; i += 100 )
          {
            const batch = data.slice( i, i + 100 );
            const values = batch.map( row =>
              "(" + cols.map( c =>
              {
                const v = row[ c ];
                if ( v === null || v === undefined ) return "NULL";
                if ( typeof v === "number" ) return String( v );
                return `'${ escSQL( String( v ) ) }'`;
              } ).join( ", " ) + ")"
            ).join( ",\n" );
            await conn.query( `INSERT INTO ${ qid( name ) } VALUES ${ values }` );
          }
        }
        // generate and execute SQL
        const sql = pipelineToSQL( steps, activeSource );
        if ( cancelled ) { await conn.close(); return; }
        const t0 = performance.now();
        const result = await conn.query( sql );
        const t1 = performance.now();
        const rows = result.toArray().map( row => row.toJSON() );
        if ( !cancelled )
        {
          setDuckDBResult( rows );
          setDuckDBTiming( Math.round( ( t1 - t0 ) * 100 ) / 100 );
        }
        // get EXPLAIN plans
        try
        {
          await conn.query( "PRAGMA explain_output = 'optimized_only'" );
          const lr = await conn.query( `EXPLAIN ${ sql }` );
          const logText = lr.toArray().map( r =>
          {
            const o = r.toJSON();
            return o.explain_value || o[ Object.keys( o ).pop() ] || "";
          } ).join( "\n" );
          await conn.query( "PRAGMA explain_output = 'physical_only'" );
          const pr = await conn.query( `EXPLAIN ${ sql }` );
          const physText = pr.toArray().map( r =>
          {
            const o = r.toJSON();
            return o.explain_value || o[ Object.keys( o ).pop() ] || "";
          } ).join( "\n" );
          if ( !cancelled ) setDuckDBPlan( { logical: logText, physical: physText } );
        } catch ( planErr )
        {
          if ( !cancelled ) setDuckDBPlan( { logical: "Plan error: " + planErr.message, physical: "" } );
        }
        await conn.close();
      } catch ( err )
      {
        if ( !cancelled ) { setDuckDBError( err.message ); setDuckDBResult( null ); }
      }
    } )();
    return () => { cancelled = true; };
  }, [ engine, duckDBStatus, rawData, steps, dataSources, activeSource ] );

  // SQL for display
  const generatedSQL = useMemo( () => engine === "duckdb" ? pipelineToSQL( steps, activeSource ) : "", [ steps, activeSource, engine ] );

  const duckDBCode = useMemo(
    () => engine === "duckdb" ? generateDuckDBCode( steps, activeSource, dataSources ) : "",
    [ steps, activeSource, dataSources, engine ]
  );

  const activeSteps = steps.filter( ( s ) => s.enabled !== false );
  const has = ( type ) => steps.some( ( s ) => s.type === type );
  const pipelineJSON = JSON.stringify( activeSteps.map( ( { id, enabled, ...rest } ) => rest ), null, 2 );

  const fpPatterns = engine === "duckdb" ? [
    [ "CTEs (WITH ... AS)", "Each pipeline step becomes a Common Table Expression. DuckDB chains them, each referencing the previous.", true ],
    [ "WHERE", "Predicate pushdown: DuckDB's optimizer may push filters below joins and aggregations automatically.", has( "filter" ) ],
    [ "GROUP BY + aggregates", "Hash aggregation. DuckDB uses vectorized execution on columnar data for fast grouping.", has( "group_aggregate" ) ],
    [ "JOIN", "DuckDB picks hash join or merge join based on cost. See the physical plan for the actual strategy.", has( "join" ) ],
    [ "Window functions", "OVER clause: DuckDB partitions and sorts once, then streams window computation.", has( "window" ) ],
    [ "EXCLUDE syntax", "DuckDB extension: SELECT * EXCLUDE (col) drops columns without listing all others.", true ],
    [ "Vectorized execution", "DuckDB processes data in vectors (batches of 2048 rows), not row-by-row. See EXPLAIN for the physical operators.", true ],
  ] : [
    [ "pipe()", "Left-to-right function composition. Each step is a function, pipe chains them into a single transformation.", true ],
    [ "Array.filter()", "Higher-order function. Takes a predicate, returns a new array. No mutation.", has( "filter" ) ],
    [ "Array.map()", "Transform each element. Compute columns use map to produce new rows with added fields.", has( "compute" ) ],
    [ "Reduce / Group", "Aggregation collapses many values into one. The reduce pattern applied to grouped data.", has( "group_aggregate" ) ],
    [ "Hash Join", "Build an index (Map) on the right table, probe with the left. O(n+m) instead of O(n*m).", has( "join" ) ],
    [ "Window / Scan", "Accumulate state across ordered rows. Running totals are a scan (prefix sum) pattern.", has( "window" ) ],
    [ "Immutability", "Every step returns new data. Toggle any step on/off: previous steps are unaffected.", true ],
    [ "Declarative descriptors", "The pipeline is data (an array of step objects), not imperative code. The executor interprets the descriptors.", true ],
  ];

  const engineSeg = (
    <div role="group" aria-label="Engine" style={ S.seg }>
      { Object.keys( ENGINES ).map( ( k ) => (
        <button key={ k } aria-pressed={ engine === k } style={ S.segBtn( engine === k ) } onClick={ () => setEngine( k ) }>{ ENGINE_SHORT[ k ] }</button>
      ) ) }
    </div>
  );

  const noDataCard = <EmptyCard action="Go to Data" onAction={ () => setTab( "data" ) }>Load a dataset first.</EmptyCard>;

  // -- Pipeline: Flow view --

  const renderInspector = ( n ) => (
    <section aria-label="Selected step" style={ { ...S.card, display: "flex", flexDirection: "column", gap: 18 } }>
      <div style={ { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 } }>
        <div style={ { display: "flex", alignItems: "center", gap: 12, minWidth: 0 } }>
          <Badge cat={ n.cat } num={ n.i + 1 } size={ 34 } />
          <div style={ { minWidth: 0 } }>
            <h2 style={ { margin: 0, fontSize: 20, fontWeight: 700 } }>{ n.meta[ 0 ] }: { stepSummary( n.step ) }</h2>
            <code style={ { ...S.mono, fontSize: 13, color: t.mute, overflowWrap: "anywhere" } }>{ stepSnippet( n.step ) }</code>
          </div>
        </div>
        <div style={ { display: "flex", flexWrap: "wrap", gap: 6 } }>
          <button style={ S.btn() } disabled={ n.i === 0 } onClick={ () => moveStep( n.step.id, -1 ) }>Move left</button>
          <button style={ S.btn() } disabled={ n.i === steps.length - 1 } onClick={ () => moveStep( n.step.id, 1 ) }>Move right</button>
          <button style={ S.btn() } onClick={ () => toggleStep( n.step.id ) }>{ n.off ? "Turn on" : "Turn off" }</button>
          <button style={ S.btn( "danger" ) } onClick={ () => removeStep( n.step.id ) }>Delete</button>
        </div>
      </div>
      <div style={ { padding: "14px 16px", borderRadius: 12, background: t.soft, display: "flex", flexDirection: "column", gap: 12 } }>
        <StepEditor step={ n.step } columns={ n.inCols } sources={ dataSources } activeSource={ activeSource } onUpdate={ updateStep( n.step.id ) } />
        <div style={ { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12, color: t.mute } }>
          <span style={ { padding: "4px 10px", borderRadius: 999, border: `1px solid ${ t.line }` } }>{ n.meta[ 3 ] }</span>
          { ENGINE_OPS[ n.step.type ] && <span style={ { ...S.mono } }>{ ENGINE_SHORT[ engine ] }: { ENGINE_OPS[ n.step.type ][ engine ] }</span> }
        </div>
      </div>
      <div style={ { display: "flex", flexWrap: "wrap", gap: 18 } }>
        <div style={ { flex: "1 1 380px", minWidth: 0 } }>
          <div style={ { ...S.label, marginBottom: 6 } }>Before, { n.inRows.length } rows</div>
          <DataTable data={ n.inRows } maxRows={ 8 } maxHeight={ 340 } />
        </div>
        <div style={ { flex: "1 1 380px", minWidth: 0 } }>
          <div style={ { ...S.label, marginBottom: 6, color: t[ n.cat + "Ink" ] } }>After, { n.outRows.length } rows ({ n.delta })</div>
          <DataTable data={ n.outRows } maxRows={ 8 } maxHeight={ 340 } highlight={ n.highlight } />
        </div>
      </div>
    </section>
  );

  const renderFlow = () => (
    <div style={ { display: "flex", flexDirection: "column", gap: 20 } }>
      <section aria-label="Pipeline graph" className="prism-dots" style={ { backgroundColor: t.soft, border: `1px solid ${ t.line }`, borderRadius: 16, padding: "24px 22px" } }>
        <div style={ { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 10px" } }>
          <div style={ { width: 150, background: t.surf, border: `1px solid ${ t.line }`, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 } }>
            <span style={ { ...S.label, fontSize: 11 } }>Source</span>
            <span style={ { fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" } }>{ activeSource }</span>
            <span style={ { display: "block", height: 6, borderRadius: 3, background: t.ink } } />
            <span style={ { ...S.mono, fontSize: 12, color: t.mute } }>{ rawData.length } rows, { colsOf( rawData ).length } cols</span>
          </div>
          { nodes.map( ( n ) => (
            <div key={ n.step.id } style={ { display: "flex", alignItems: "center", gap: 10 } }>
              <FlowLink count={ n.inRows.length } onInsert={ () => setInsertAt( n.i ) } />
              <button
                onClick={ () => { setSelectedId( n.step.id ); setInsertAt( null ); } }
                aria-pressed={ n.isSel }
                style={ {
                  width: 160, textAlign: "left", background: t.surf, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6,
                  font: "inherit", color: t.ink, cursor: "pointer", opacity: n.off ? 0.5 : 1,
                  border: n.isSel ? `2px solid ${ t[ n.cat + "Ink" ] }` : `1px solid ${ t.line }`, boxShadow: n.isSel ? `0 0 0 4px ${ t[ n.cat + "Bg" ] }` : "none",
                } }
              >
                <span style={ { fontSize: 11, fontWeight: 600, letterSpacing: 1, color: t[ n.cat + "Ink" ] } }>{ n.i + 1 }. { n.meta[ 0 ].toUpperCase() }</span>
                <span style={ { fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" } }>{ stepSummary( n.step ) }</span>
                <RowBar pct={ ( n.outRows.length / rawData.length ) * 100 } color={ t[ n.cat + "Ink" ] } />
                <span style={ { ...S.mono, fontSize: 12, color: t.mute } }>{ n.outRows.length } rows, { n.delta }</span>
              </button>
            </div>
          ) ) }
          <div style={ { display: "flex", alignItems: "center", gap: 10 } }>
            <FlowLink count={ transformedData.length } />
            <button onClick={ () => setInsertAt( steps.length ) } style={ { width: 130, minHeight: 104, border: `2px dashed ${ t.mute }`, borderRadius: 14, background: t.surf, font: "inherit", fontSize: 15, fontWeight: 600, color: t.ink, cursor: "pointer" } }>+ Add step</button>
          </div>
        </div>
        <p style={ { margin: "14px 0 0", fontSize: 13, color: t.mute } }>The number on each link is how many rows flow into the next step. The bar shows the share of source rows still flowing.</p>
      </section>
      { insertAt !== null
        ? <StepLibrary title={ `Add a step at position ${ insertAt + 1 }` } onPick={ addStep } onCancel={ () => setInsertAt( null ) } />
        : selNode ? renderInspector( selNode )
          : <EmptyCard>{ steps.length ? "Click a step to edit it, or press + to add one." : "Press + Add step to start your pipeline." }</EmptyCard> }
    </div>
  );

  // -- Pipeline: Notebook view --

  const renderNotebook = () => (
    <div style={ { display: "flex", flexDirection: "column" } }>
      <section aria-label="Source" style={ { ...S.card, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" } }>
        <div style={ { flex: "1 1 300px" } }>
          <div style={ S.label }>Source, an immutable value</div>
          <div style={ { fontSize: 19, fontWeight: 600, marginTop: 4 } }>{ activeSource }</div>
        </div>
        <div style={ { textAlign: "right" } }>
          <div style={ { fontSize: 34, fontWeight: 700, lineHeight: 1 } }>{ rawData.length }</div>
          <div style={ { fontSize: 13, color: t.mute } }>rows, { colsOf( rawData ).length } columns</div>
        </div>
      </section>
      { nodes.map( ( n ) =>
      {
        const ink = t[ n.cat + "Ink" ];
        return (
          <div key={ n.step.id } style={ { display: "flex", flexDirection: "column" } }>
            <InsertRow label={ `${ n.inRows.length } rows` } onInsert={ () => setInsertAt( n.i ) } />
            { insertAt === n.i && <div style={ { marginBottom: 12 } }><StepLibrary title={ `Add a step at position ${ n.i + 1 }` } onPick={ addStep } onCancel={ () => setInsertAt( null ) } /></div> }
            <section
              aria-label={ `Step ${ n.i + 1 }` }
              draggable
              onDragStart={ () => setDragIdx( n.i ) }
              onDragOver={ ( e ) => e.preventDefault() }
              onDrop={ ( e ) => handleDrop( e, n.i ) }
              style={ { background: t.surf, borderRadius: 16, overflow: "hidden", border: n.isSel ? `2px solid ${ ink }` : `1px solid ${ t.line }`, opacity: n.off ? 0.6 : 1 } }
            >
              <div style={ { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 18px", padding: "16px 22px" } }>
                <span aria-hidden="true" title="Drag to reorder" style={ { cursor: "grab", color: t.mute, ...S.mono, userSelect: "none" } }>::</span>
                <Badge cat={ n.cat } num={ n.i + 1 } />
                <div style={ { flex: "1 1 300px", minWidth: 0 } }>
                  <div style={ { fontSize: 17, fontWeight: 600 } }>{ n.meta[ 0 ] }: { stepSummary( n.step ) }</div>
                  <code style={ { ...S.mono, fontSize: 13, color: t.mute, overflowWrap: "anywhere" } }>{ stepSnippet( n.step ) }</code>
                </div>
                <span style={ { fontSize: 12, padding: "3px 9px", borderRadius: 999, border: `1px solid ${ t.line }`, color: t.mute } }>{ n.meta[ 3 ] }</span>
                <div style={ { display: "flex", alignItems: "center", gap: 10, minWidth: 220 } }>
                  <span style={ { flex: 1 } }><RowBar pct={ ( n.outRows.length / rawData.length ) * 100 } color={ ink } height={ 10 } /></span>
                  <span style={ { fontSize: 14, fontWeight: 700 } }>{ n.outRows.length } rows</span>
                  <span style={ { ...S.chip( n.cat ), fontSize: 12, padding: "2px 8px", borderRadius: 6 } }>{ n.delta }</span>
                </div>
                <div style={ { display: "flex", flexWrap: "wrap", gap: 6 } }>
                  <button aria-pressed={ n.isSel } style={ S.btn() } onClick={ () => { setSelectedId( n.isSel ? null : n.step.id ); setInsertAt( null ); } }>{ n.isSel ? "Done" : "Edit" }</button>
                  <button style={ S.btn() } onClick={ () => toggleStep( n.step.id ) }>{ n.off ? "Turn on" : "Turn off" }</button>
                  <button style={ S.btn( "danger" ) } onClick={ () => removeStep( n.step.id ) }>Delete</button>
                </div>
              </div>
              { n.isSel && (
                <div style={ { margin: "0 22px 14px", padding: "14px 16px", borderRadius: 12, background: t.soft } }>
                  <StepEditor step={ n.step } columns={ n.inCols } sources={ dataSources } activeSource={ activeSource } onUpdate={ updateStep( n.step.id ) } />
                </div>
              ) }
              <div style={ { padding: "0 22px 18px" } }>
                <DataTable data={ n.outRows } maxRows={ 3 } maxHeight={ 220 } highlight={ n.highlight } />
              </div>
            </section>
          </div>
        );
      } ) }
      <InsertRow label={ `${ transformedData.length } rows out` } />
      { insertAt === steps.length && <div style={ { marginBottom: 12 } }><StepLibrary title={ `Add a step at position ${ steps.length + 1 }` } onPick={ addStep } onCancel={ () => setInsertAt( null ) } /></div> }
      <button style={ { ...S.btn( "dashed" ), alignSelf: "flex-start", marginLeft: 24, padding: "14px 22px", fontSize: 15, fontWeight: 600 } } onClick={ () => setInsertAt( steps.length ) }>+ Add step at the end</button>
    </div>
  );

  return (
    <ThemeCtx.Provider value={ { t, S } }>
      <div style={ S.app }>
        <style>{ `
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
          * { box-sizing: border-box; }
          body { margin: 0; background: ${ t.bg }; }
          ::-webkit-scrollbar { width: 8px; height: 8px; }
          ::-webkit-scrollbar-track { background: ${ t.soft }; }
          ::-webkit-scrollbar-thumb { background: ${ t.line }; border-radius: 4px; }
          button:not(:disabled):hover { filter: brightness(${ t.dark ? 1.12 : 0.97 }); }
          button:disabled { opacity: 0.45; cursor: not-allowed; }
          :focus-visible { outline: 2px solid ${ t.acc }; outline-offset: 2px; }
          textarea { resize: vertical; }
          .prism-dots { background-image: radial-gradient(rgba(128,128,128,0.32) 1px, transparent 1px); background-size: 18px 18px; }
        `}</style>

        {/* Header */ }
        <header style={ { background: t.surf, borderBottom: `1px solid ${ t.line }` } }>
          <div style={ { maxWidth: 1280, margin: "0 auto", padding: "12px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 24px" } }>
            <button onClick={ () => setTab( "data" ) } style={ { display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", color: t.ink, font: "inherit", padding: 0 } }>
              <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3 L25 24 H3 Z" fill={ t.accSoft } stroke={ t.acc } strokeWidth="2.2" strokeLinejoin="round" /><path d="M14 3 L14 24" stroke={ t.acc } strokeWidth="2.2" /></svg>
              <span style={ { fontWeight: 700, fontSize: 20 } }>Prism</span>
            </button>
            <nav aria-label="Workflow" style={ { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, flex: "1 1 auto" } }>
              { MAIN_TABS.map( ( x, i ) => (
                <button key={ x.key } aria-current={ tab === x.key ? "page" : undefined } style={ S.navBtn( tab === x.key ) } onClick={ () => setTab( x.key ) }>{ i + 1 } { x.label }</button>
              ) ) }
              <span style={ { width: 1, height: 24, background: t.line, margin: "0 8px" } } />
              { HOOD_TABS.map( ( x ) => (
                <button key={ x.key } aria-current={ tab === x.key ? "page" : undefined } style={ { ...S.navBtn( tab === x.key ), fontSize: 13 } } onClick={ () => setTab( x.key ) }>{ x.label }</button>
              ) ) }
            </nav>
            <div style={ { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }>
              <select aria-label="Engine" title={ ENGINES[ engine ].description } style={ { ...S.input, fontSize: 13 } } value={ engine } onChange={ ( e ) => setEngine( e.target.value ) }>
                { Object.entries( ENGINES ).map( ( [ key, eng ] ) => <option key={ key } value={ key }>{ eng.name }</option> ) }
              </select>
              <div role="group" aria-label="Palette" style={ { display: "flex", gap: 4, padding: 4, borderRadius: 12, background: t.soft } }>
                { Object.entries( THEMES ).map( ( [ key, th ] ) => (
                  <button key={ key } aria-pressed={ palette === key } onClick={ () => setPalette( key ) } style={ { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", border: "none", borderRadius: 9, font: "inherit", fontSize: 13, cursor: "pointer", ...( palette === key ? { background: t.ink, color: t.bg } : { background: "transparent", color: t.ink } ) } }>
                    { th.swatch.map( ( c ) => <span key={ c } style={ { width: 10, height: 10, borderRadius: 5, background: c, border: `1px solid ${ t.line }` } } /> ) }
                    { th.name }
                  </button>
                ) ) }
              </div>
              <button style={ S.btn() } onClick={ saveDashboard }>Save</button>
              <label style={ { ...S.btn(), display: "inline-flex", alignItems: "center" } }>
                Load
                <input type="file" accept=".json" style={ { display: "none" } } onChange={ loadDashboard } />
              </label>
            </div>
          </div>
        </header>

        {/* DATA TAB */ }
        { tab === "data" && (
          <main style={ S.main }>
            <PageTitle title="Start with a value" sub="A dataset is an immutable value. Nothing in Prism changes it: every pipeline step returns a new one.">
              <button style={ S.btn( "primary" ) } disabled={ !hasData } onClick={ () => setTab( "pipeline" ) }>Build a pipeline</button>
            </PageTitle>

            <section aria-label="Sample datasets" style={ { display: "flex", flexDirection: "column", gap: 12 } }>
              <h2 style={ { ...S.label, margin: 0 } }>Sample datasets</h2>
              <div style={ { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 } }>
                { Object.entries( SAMPLE_DATASETS ).map( ( [ key, ds ] ) =>
                {
                  const on = dataSource === key;
                  return (
                    <button key={ key } aria-pressed={ on } onClick={ () => loadSample( key ) } style={ { textAlign: "left", padding: 16, borderRadius: 14, cursor: "pointer", font: "inherit", color: t.ink, display: "flex", flexDirection: "column", gap: 6, border: on ? `2px solid ${ t.acc }` : `1px solid ${ t.line }`, background: on ? t.accSoft : t.surf } }>
                      <span style={ { fontSize: 16, fontWeight: 600 } }>{ ds.name }</span>
                      <span style={ { fontSize: 13, color: t.mute } }>{ ds.description }</span>
                      <span style={ { ...S.mono, fontSize: 12, color: on ? t.accInk : t.mute } }>{ Object.values( ds.files ).map( ( f ) => f.name ).join( " + " ) }</span>
                    </button>
                  );
                } ) }
              </div>
            </section>

            <section aria-label="Bring your own data" style={ { ...S.card, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 } }>
              <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>
                <label htmlFor="prism-csv" style={ S.label }>Paste CSV</label>
                <textarea id="prism-csv" style={ { ...S.input, ...S.mono, height: 96, fontSize: 13 } } value={ csvText } onChange={ ( e ) => setCsvText( e.target.value ) } placeholder={ "name,age,city\nAlice,30,Portland" } />
                <button style={ { ...S.btn( "primary" ), alignSelf: "flex-start" } } disabled={ !csvText.trim() } onClick={ () => parseAndSetData( csvText, "csv" ) }>Parse CSV</button>
              </div>
              <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>
                <label htmlFor="prism-json" style={ S.label }>Paste JSON</label>
                <textarea id="prism-json" style={ { ...S.input, ...S.mono, height: 96, fontSize: 13 } } value={ jsonText } onChange={ ( e ) => setJsonText( e.target.value ) } placeholder='[{"name":"Alice","age":30}]' />
                <button style={ { ...S.btn( "primary" ), alignSelf: "flex-start" } } disabled={ !jsonText.trim() } onClick={ () => parseAndSetData( jsonText, "json" ) }>Parse JSON</button>
              </div>
              <div style={ { display: "flex", flexDirection: "column", gap: 16 } }>
                <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>
                  <label htmlFor="prism-upload" style={ S.label }>Upload CSV files</label>
                  <input id="prism-upload" type="file" accept=".csv,.tsv" multiple onChange={ handleMultiFileUpload } style={ { color: t.mute, fontSize: 13 } } />
                </div>
                <div style={ { display: "flex", flexDirection: "column", gap: 8 } }>
                  <label htmlFor="prism-source" style={ S.label }>Named source, for joins</label>
                  <div style={ { display: "flex", gap: 8 } }>
                    <input id="prism-source" style={ { ...S.input, width: 160 } } placeholder="source name" value={ newSourceName } onChange={ ( e ) => setNewSourceName( e.target.value ) } onKeyDown={ ( e ) => { if ( e.key === "Enter" ) createSource(); } } />
                    <button style={ S.btn() } disabled={ !newSourceName.trim() } onClick={ createSource }>Create</button>
                  </div>
                </div>
              </div>
            </section>

            { sourceNames.length > 0 && (
              <>
                <div role="group" aria-label="Data sources" style={ { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } }>
                  <span style={ { ...S.label, marginRight: 6 } }>Sources</span>
                  { sourceNames.map( ( name ) => (
                    <button key={ name } aria-pressed={ activeSource === name } style={ S.pill( activeSource === name ) } onClick={ () => setActiveSource( name ) }>
                      { name } ({ ( dataSources[ name ] || [] ).length } rows)
                    </button>
                  ) ) }
                </div>
                { hasData ? (
                  <div style={ { display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" } }>
                    <section aria-label="Preview" style={ { ...S.card, flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 } }>
                      <div style={ { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 } }>
                        <h2 style={ S.h2 }>{ activeSource }</h2>
                        <span style={ { fontSize: 13, color: t.mute } }>{ rawData.length } rows, { colsOf( rawData ).length } columns</span>
                      </div>
                      <DataTable data={ rawData } maxRows={ 50 } />
                      <div style={ { background: t.codeBg, borderRadius: 12, padding: "12px 14px", display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" } }>
                        <code style={ { ...S.mono, fontSize: 13 } }>const source = Object.freeze(parse(text))</code>
                        <span style={ { fontSize: 13, color: t.mute } }>Parsing is a pure function too: the same text always gives the same rows.</span>
                      </div>
                    </section>
                    <section aria-label="Schema" style={ { ...S.card, flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 12 } }>
                      <div>
                        <h2 style={ S.h2 }>Schema</h2>
                        <code style={ { ...S.mono, fontSize: 12, color: t.mute } }>columns.map(c =&gt; inferType(values(c)))</code>
                      </div>
                      <ColumnStats data={ rawData } />
                      <p style={ { margin: 0, fontSize: 13, color: t.mute } }>Types are inferred, not declared. Override any column later with a Cast step.</p>
                    </section>
                  </div>
                ) : (
                  <EmptyCard>Source "{ activeSource }" is empty. Paste data or upload a file.</EmptyCard>
                ) }
              </>
            ) }
          </main>
        ) }

        {/* PIPELINE TAB */ }
        { tab === "pipeline" && (
          <main style={ S.main }>
            <PageTitle title="Build your pipeline" sub="Each step is a pure function from rows to rows. Press + anywhere to insert a step, click a step to edit it.">
              <div role="group" aria-label="View" style={ S.seg }>
                <button aria-pressed={ pipeView === "flow" } style={ S.segBtn( pipeView === "flow" ) } onClick={ () => { setPipeView( "flow" ); setInsertAt( null ); } }>Flow</button>
                <button aria-pressed={ pipeView === "notebook" } style={ S.segBtn( pipeView === "notebook" ) } onClick={ () => { setPipeView( "notebook" ); setInsertAt( null ); } }>Notebook</button>
              </div>
              <button style={ S.btn( "primary" ) } disabled={ !hasData } onClick={ () => setTab( "chart" ) }>Chart the result</button>
            </PageTitle>
            { !hasData ? noDataCard : (
              <>
                <section aria-label="Pipeline as one expression" style={ { background: t.codeBg, border: `1px solid ${ t.line }`, borderRadius: 14, padding: "14px 20px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px" } }>
                  <span style={ S.label }>The whole pipeline</span>
                  <div style={ { ...S.mono, fontSize: 13, flex: "1 1 520px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } }>
                    <span>run = pipe(</span>
                    { nodes.length === 0 && <span style={ { color: t.mute } }>identity</span> }
                    { nodes.map( ( n ) => (
                      <span key={ n.step.id } style={ { padding: "2px 7px", borderRadius: 5, ...S.chip( n.cat ), ...( n.off ? { textDecoration: "line-through", opacity: 0.6 } : {} ) } }>{ n.step.type }({ stepSummary( n.step ) })</span>
                    ) ) }
                    <span>)</span>
                  </div>
                  <span style={ { ...S.mono, fontSize: 13, color: t.mute } }>{ [ rawData.length, ...nodes.map( ( n ) => n.outRows.length ) ].join( " -> " ) } rows</span>
                </section>
                { pipeView === "flow" ? renderFlow() : renderNotebook() }
              </>
            ) }
          </main>
        ) }

        {/* CHART TAB */ }
        { tab === "chart" && (
          <main style={ S.main }>
            <PageTitle title="A chart is a function of data" sub="render(spec)(rows): the same spec and the same rows always draw the same picture.">
              <button style={ S.btn( "primary" ) } disabled={ !hasData || !chartConfig.xColumn || !chartConfig.yColumns.length } onClick={ addChartToDashboard }>Add to dashboard</button>
            </PageTitle>
            { !hasData ? noDataCard : (
              <div style={ { display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" } }>
                <aside aria-label="Chart settings" style={ { ...S.card, flex: "1 1 260px", maxWidth: 320, display: "flex", flexDirection: "column", gap: 16 } }>
                  <div style={ { fontSize: 13, color: t.mute } }>Rows: pipeline output, <strong style={ { color: t.ink } }>{ transformedData.length }</strong> rows after { activeSteps.length } step{ activeSteps.length !== 1 ? "s" : "" }</div>
                  <Field label="Chart type">
                    <div role="group" aria-label="Chart type" style={ { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 } }>
                      { CHART_TYPES.map( ( ct ) => (
                        <button key={ ct } aria-pressed={ chartConfig.type === ct } style={ S.pill( chartConfig.type === ct ) } onClick={ () => setChartConfig( ( c ) => ( { ...c, type: ct } ) ) }>{ ct.replace( /_/g, " " ) }</button>
                      ) ) }
                    </div>
                  </Field>
                  <Field label="X axis"><Choice label="X axis" value={ chartConfig.xColumn } options={ currentColumns } onChange={ ( v ) => setChartConfig( ( c ) => ( { ...c, xColumn: v } ) ) } /></Field>
                  <Field label="Y axis (one or more)"><MultiChoice label="Y axis" values={ chartConfig.yColumns } options={ currentColumns } onChange={ ( v ) => setChartConfig( ( c ) => ( { ...c, yColumns: v } ) ) } /></Field>
                  <Field label="Color by (optional)">
                    <select aria-label="Color by" style={ S.input } value={ chartConfig.colorColumn } onChange={ ( e ) => setChartConfig( ( c ) => ( { ...c, colorColumn: e.target.value } ) ) }>
                      <option value="">none</option>
                      { currentColumns.map( ( c ) => <option key={ c } value={ c }>{ c }</option> ) }
                    </select>
                  </Field>
                </aside>
                <section aria-label="Chart preview" style={ { ...S.card, flex: "999 1 480px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 } }>
                  <h2 style={ S.h2 }>{ chartTitle( chartConfig ) }</h2>
                  <ChartRenderer config={ chartConfig } data={ transformedData } height={ 340 } />
                  <div style={ { display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: t.mute } }>
                    <span style={ { padding: "4px 10px", borderRadius: 999, background: t.soft } }>source: { activeSource }</span>
                    <span style={ { padding: "4px 10px", borderRadius: 999, background: t.soft } }>via { activeSteps.length } pipeline step{ activeSteps.length !== 1 ? "s" : "" }</span>
                    <span style={ { padding: "4px 10px", borderRadius: 999, background: t.soft } }>re-renders when the pipeline changes</span>
                  </div>
                </section>
                <aside aria-label="Chart spec" style={ { flex: "1 1 280px", maxWidth: 340, display: "flex", flexDirection: "column", gap: 14 } }>
                  <div style={ S.card }>
                    <div style={ S.label }>The chart as data</div>
                    <pre style={ { ...S.code, marginTop: 10 } }>{ `const spec = ${ JSON.stringify( chartConfig, null, 2 ) }\n\nconst draw = render(spec)\ndraw(run(source))` }</pre>
                  </div>
                  <div style={ { background: t.colsBg, borderRadius: 16, padding: "16px 18px" } }>
                    <div style={ { ...S.label, color: t.colsInk } }>Concept: currying</div>
                    <p style={ { margin: "6px 0 0", fontSize: 14, lineHeight: 1.5 } }>render(spec) returns a function still waiting for rows. Build it once, then reuse it on any data with the same shape.</p>
                  </div>
                </aside>
              </div>
            ) }
          </main>
        ) }

        {/* DASHBOARD TAB */ }
        { tab === "dashboard" && (
          <main style={ S.main }>
            <PageTitle title="Dashboard" sub={ <>A dashboard is <code style={ S.mono }>charts.map(render)</code>. Each tile keeps its own spec and pipeline, and is recomputed from the source.</> }>
              <span style={ { fontSize: 13, color: t.mute } }>{ dashboardCharts.length } chart{ dashboardCharts.length !== 1 ? "s" : "" }</span>
              <button style={ S.btn() } onClick={ () => setTab( "chart" ) }>+ Add chart</button>
              <button style={ S.btn( "primary" ) } onClick={ saveDashboard }>Save dashboard</button>
            </PageTitle>
            { dashboardCharts.length === 0 ? (
              <EmptyCard action="Build a chart" onAction={ () => setTab( "chart" ) }>No charts yet. Configure a chart and press "Add to dashboard".</EmptyCard>
            ) : (
              <div style={ { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))", gap: 16 } }>
                { dashboardCharts.map( ( chart ) =>
                {
                  const chartData = rawData ? buildPipeline( chart.steps, context )( rawData ) : [];
                  const n = chart.steps.filter( ( s ) => s.enabled !== false ).length;
                  return (
                    <section key={ chart.id } aria-label={ chartTitle( chart.config ) } style={ { ...S.card, display: "flex", flexDirection: "column", gap: 12 } }>
                      <div style={ { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } }>
                        <h2 style={ { ...S.h2, fontSize: 17 } }>{ chartTitle( chart.config ) }</h2>
                        <button style={ { ...S.btn( "danger" ), padding: "7px 11px", fontSize: 13 } } onClick={ () => removeChartFromDashboard( chart.id ) }>Remove</button>
                      </div>
                      <ChartRenderer config={ chart.config } data={ chartData } />
                      <div style={ { ...S.mono, fontSize: 12, color: t.mute, paddingTop: 8, borderTop: `1px solid ${ t.line }` } }>
                        { activeSource } |&gt; { n } step{ n !== 1 ? "s" : "" } |&gt; { chart.config.type.replace( /_/g, " " ) }
                      </div>
                    </section>
                  );
                } ) }
              </div>
            ) }
          </main>
        ) }

        {/* CODE TAB */ }
        { tab === "code" && (
          <main style={ S.main }>
            <PageTitle title="The same pipeline, as code" sub="Generated from the steps you built. Switch the engine to see the same logical pipeline on another runtime.">
              { engineSeg }
              <button style={ S.btn() } onClick={ () => navigator.clipboard.writeText( engine === "duckdb" ? duckDBCode : code ) }>Copy</button>
            </PageTitle>
            <div style={ { display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" } }>
              <section aria-label="Generated code" style={ { ...S.card, flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 } }>
                <div style={ { fontSize: 13, color: t.mute } }>{ ENGINES[ engine ].name }: { ENGINES[ engine ].description }</div>
                <pre style={ { ...S.code, maxHeight: 620, overflowY: "auto" } }>{ engine === "duckdb" ? duckDBCode : code }</pre>
                { engine === "duckdb" && duckDBTiming !== null && (
                  <div style={ { padding: "10px 14px", borderRadius: 10, background: t.cmbBg, color: t.cmbInk, fontSize: 13 } }>
                    DuckDB execution: { duckDBTiming } ms, { duckDBResult ? duckDBResult.length : 0 } rows returned
                  </div>
                ) }
                { engine === "duckdb" && duckDBError && (
                  <div style={ { padding: "10px 14px", borderRadius: 10, background: t.clnBg, color: t.clnInk, fontSize: 13 } }>DuckDB error: { duckDBError }</div>
                ) }
              </section>
              <aside style={ { flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12 } }>
                <div style={ { ...S.card, display: "flex", flexDirection: "column", gap: 12 } }>
                  <h2 style={ { ...S.label, margin: 0 } }>{ engine === "duckdb" ? "DuckDB SQL patterns" : "Functional ideas in this code" }</h2>
                  { steps.length === 0 ? (
                    <p style={ { margin: 0, fontSize: 13, color: t.mute } }>Add transform steps to see the patterns they use.</p>
                  ) : fpPatterns.filter( ( p ) => p[ 2 ] ).map( ( [ term, desc ] ) => (
                    <div key={ term }>
                      <div style={ { fontSize: 15, fontWeight: 600 } }>{ term }</div>
                      <p style={ { margin: "2px 0 0", fontSize: 13, lineHeight: 1.5, color: t.mute } }>{ desc }</p>
                    </div>
                  ) ) }
                </div>
                <div style={ S.card }>
                  <h2 style={ { ...S.label, margin: 0 } }>The pipeline is data</h2>
                  <pre style={ { ...S.code, fontSize: 12, marginTop: 10, maxHeight: 300, overflowY: "auto" } }>{ pipelineJSON }</pre>
                  <p style={ { margin: "8px 0 0", fontSize: 13, color: t.mute } }>Save, load and share it as JSON. Each engine interprets the same list.</p>
                </div>
              </aside>
            </div>
          </main>
        ) }

        {/* PLAN TAB */ }
        { tab === "plan" && (
          <main style={ S.main }>
            <PageTitle title="What the engine actually runs" sub="Logical plan: what you asked for. Physical plan: how the selected engine does it.">
              { engineSeg }
            </PageTitle>
            { engine === "duckdb" && duckDBStatus === "loading" && <div style={ { fontSize: 13, color: t.rowsInk } }>Initializing DuckDB WASM...</div> }
            { engine === "duckdb" && duckDBTiming !== null && <div style={ { fontSize: 13, color: t.cmbInk } }>Executed in { duckDBTiming } ms</div> }
            { activeSteps.length === 0 ? (
              <EmptyCard action="Build a pipeline" onAction={ () => setTab( "pipeline" ) }>Add transform steps to see the query plan.</EmptyCard>
            ) : (
              <>
                { engine === "duckdb" && ( duckDBPlan.logical || duckDBPlan.physical ) && (
                  <div style={ { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16 } }>
                    <section style={ S.card }>
                      <div style={ { ...S.label, color: t.colsInk, marginBottom: 8 } }>DuckDB logical plan (EXPLAIN optimized_only)</div>
                      <pre style={ { ...S.code, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre", maxHeight: 400, overflow: "auto" } }>{ duckDBPlan.logical || "(waiting for execution...)" }</pre>
                    </section>
                    <section style={ S.card }>
                      <div style={ { ...S.label, color: t.cmbInk, marginBottom: 8 } }>DuckDB physical plan (EXPLAIN physical_only)</div>
                      <pre style={ { ...S.code, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre", maxHeight: 400, overflow: "auto" } }>{ duckDBPlan.physical || "(waiting for execution...)" }</pre>
                    </section>
                  </div>
                ) }
                { engine === "duckdb" && duckDBError && (
                  <div style={ { padding: "10px 14px", borderRadius: 10, background: t.clnBg, color: t.clnInk, fontSize: 13 } }>DuckDB error: { duckDBError }</div>
                ) }
                { engine === "duckdb" && (
                  <section style={ S.card }>
                    <div style={ { ...S.label, color: t.rowsInk, marginBottom: 8 } }>Generated SQL</div>
                    <pre style={ { ...S.code, fontSize: 12, whiteSpace: "pre", maxHeight: 220, overflow: "auto" } }>{ generatedSQL }</pre>
                  </section>
                ) }

                <section style={ S.card }>
                  <div style={ { ...S.label, marginBottom: 8 } }>{ engine === "duckdb" ? "Prism logical / physical plan (hand-built)" : "Query plan" }</div>
                  <PlanSVG logicalNodes={ logicalNodes } physicalNodes={ physicalNodes } optimizerRules={ optimized.rules } />
                </section>

                <div style={ { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" } }>
                  <section style={ { ...S.card, flex: "999 1 480px", minWidth: 0 } }>
                    <div style={ { ...S.label, color: t.rowsInk, marginBottom: 8 } }>Optimizer rules</div>
                    { optimized.rules.length === 0 ? (
                      <p style={ { margin: 0, fontSize: 14, color: t.mute } }>No rewrite rules apply to this pipeline.</p>
                    ) : optimized.rules.map( ( rule, i ) => (
                      <div key={ i } style={ { padding: "8px 0", borderBottom: i < optimized.rules.length - 1 ? `1px solid ${ t.line }` : "none", fontSize: 14 } }>
                        <strong>{ rule.rule }</strong>
                        <span style={ { color: t.mute } }>: { rule.desc }</span>
                      </div>
                    ) ) }
                  </section>
                  <div style={ { flex: "1 1 300px", background: t.sumBg, borderRadius: 16, padding: "16px 18px" } }>
                    <div style={ { ...S.label, color: t.sumInk } }>Concept: referential transparency</div>
                    <p style={ { margin: "6px 0 0", fontSize: 14, lineHeight: 1.5 } }>A pure step can be replaced by its result, merged with a neighbour or moved, and the answer stays the same. That is what gives an engine room to optimize.</p>
                  </div>
                </div>

                <section style={ S.card }>
                  <div style={ { ...S.label, marginBottom: 8 } }>Engine operator mapping</div>
                  <div style={ { overflowX: "auto", border: `1px solid ${ t.line }`, borderRadius: 10 } }>
                    <table style={ { width: "100%", borderCollapse: "collapse", fontSize: 12 } }>
                      <thead>
                        <tr>
                          <th style={ S.th }>Operation</th>
                          <th style={ S.th }>JS (Array)</th>
                          <th style={ S.th }>Arrow (conceptual)</th>
                          <th style={ S.th }>WebGPU</th>
                          <th style={ S.th }>DuckDB (SQL)</th>
                        </tr>
                      </thead>
                      <tbody>
                        { activeSteps.map( ( step, i ) =>
                        {
                          const ops = ENGINE_OPS[ step.type ];
                          if ( !ops ) return null;
                          const cat = stepMeta( step )[ 1 ];
                          return (
                            <tr key={ i }>
                              <td style={ { ...S.td } }><span style={ { ...S.chip( cat ), padding: "3px 9px", borderRadius: 6, fontWeight: 600 } }>{ step.type }</span></td>
                              <td style={ { ...S.td, ...S.mono, whiteSpace: "normal" } }>{ ops.js }</td>
                              <td style={ { ...S.td, ...S.mono, whiteSpace: "normal" } }>{ ops.arrow }</td>
                              <td style={ { ...S.td, ...S.mono, whiteSpace: "normal" } }>{ ops.webgpu }</td>
                              <td style={ { ...S.td, ...S.mono, whiteSpace: "normal", color: t.cmbInk } }>{ ops.duckdb }</td>
                            </tr>
                          );
                        } ) }
                      </tbody>
                    </table>
                  </div>
                </section>

                { engine === "duckdb" && duckDBResult && (
                  <section style={ S.card }>
                    <div style={ { ...S.label, marginBottom: 8 } }>DuckDB execution result ({ duckDBResult.length } rows, { duckDBTiming } ms)</div>
                    <DataTable data={ duckDBResult } maxRows={ 20 } />
                  </section>
                ) }
              </>
            ) }
          </main>
        ) }

        <footer style={ { padding: "24px 24px 32px", textAlign: "center", fontSize: "10pt", color: t.mute } }>
          By SHAURYASHAURYA &copy; 2026
        </footer>
      </div>
    </ThemeCtx.Provider>
  );
}
