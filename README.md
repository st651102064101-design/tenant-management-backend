# Tenant Management Backend

## Overview

This repository provides an Express‑based REST API to support the Vue frontend of the tenant management system. It connects to a MySQL database using the **mysql2** driver and exposes endpoints to manage tenants, scanned packages and summary reports. The Express documentation notes that adding database support simply requires loading the appropriate Node.js driver for your chosen database [oai_citation:0‡expressjs.com](https://expressjs.com/en/guide/database-integration.html#:~:text=Database%20integration), while MySQL examples show how to configure a connection using host, user, password and database parameters [oai_citation:1‡expressjs.com](https://expressjs.com/en/guide/database-integration.html#:~:text=Example). To improve performance, this project uses a **connection pool**, which reuses connections rather than opening a new one for each request [oai_citation:2‡sidorares.github.io](https://sidorares.github.io/node-mysql2/docs#:~:text=Using%20Connection%20Pools).

## Features

### Automatic database setup

On startup the server creates a MySQL database named **tenant_management_db** (if it does not exist) and three tables: **tenants**, **scanned_packages** and **reports**. You can also run `init.sql` manually.

### API endpoints

| Method & path | Function |
|---------------|---------|
| `GET /api/tenants` | List all tenants. |
| `GET /api/tenants/:id` | Retrieve a single tenant. |
| `POST /api/tenants` | Create a new tenant. |
| `PUT /api/tenants/:id` | Update an existing tenant. |
| `DELETE /api/tenants/:id` | Delete a tenant. |
| `GET /api/scanned-packages` | List all scanned packages, including matched tenant details. |
| `POST /api/scanned-packages` | Create a new scanned package. |
| `PUT /api/scanned-packages/:id/match/:tenantId` | Associate a scanned package with a tenant. |
| `GET /api/reports` | Generate a summary report. |

## Setup and usage

1. Install dependencies:
   ```bash
   npm install