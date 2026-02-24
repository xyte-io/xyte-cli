#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;

function usage() {
  process.stderr.write('Usage: validate_with_schema.js <schema.json> <data.json>\n');
  process.exit(1);
}

const [, , schemaPathArg, dataPathArg] = process.argv;
if (!schemaPathArg || !dataPathArg) {
  usage();
}

const schemaPath = path.resolve(schemaPathArg);
const dataPath = path.resolve(dataPathArg);

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(schema);

if (!validate(data)) {
  process.stderr.write(`Schema validation failed for ${dataPath}\n`);
  process.stderr.write(`${JSON.stringify(validate.errors, null, 2)}\n`);
  process.exit(2);
}

process.stdout.write(`Schema validation passed: ${path.basename(dataPath)} against ${path.basename(schemaPath)}\n`);
