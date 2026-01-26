-- SQL script to create the database and tables for the tenant management system

CREATE DATABASE IF NOT EXISTS tenant_management_db
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE tenant_management_db;

CREATE TABLE IF NOT EXISTS tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL,
  room VARCHAR(50) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scanned_packages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  recipient_name VARCHAR(255),
  address VARCHAR(255),
  tenant_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(100),
  date DATE,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Mock data for tenants
INSERT INTO tenants (name, address, room, phone) VALUES
('สมชาย นำแสง', '123 ซอยลาดพร้าว', '101', '081-234-5601'),
('นิดา ศรีอรุณ', '123 ซอยลาดพร้าว', '102', '081-234-5602'),
('วิชัย จันทร์เพ็ญ', '123 ซอยลาดพร้าว', '103', '081-234-5603'),
('สมหญิง ดวงสวัสดิ์', '123 ซอยลาดพร้าว', '201', '081-234-5604'),
('ประเสริฐ เพชรยวน', '123 ซอยลาดพร้าว', '202', '081-234-5605');

-- Mock data for scanned_packages
INSERT INTO scanned_packages (recipient_name, address, tenant_id) VALUES
('สมชาย นำแสง', '123 ซอยลาดพร้าว ห้อง 101', 1),
('นิดา ศรีอรุณ', '123 ซอยลาดพร้าว ห้อง 102', 2),
('วิชัย จันทร์เพ็ญ', '123 ซอยลาดพร้าว ห้อง 103', 3),
('สมหญิง ดวงสวัสดิ์', '123 ซอยลาดพร้าว ห้อง 201', 4),
('ประเสริฐ เพชรยวน', '123 ซอยลาดพร้าว ห้อง 202', 5),
('สมชาย นำแสง', '123 ซอยลาดพร้าว ห้อง 101', 1);

-- Mock data for reports
INSERT INTO reports (type, date, description) VALUES
('monthly', '2024-12-01', 'รายงานการเช่ารายเดือนธันวาคม 2024 - ผู้เช่า 5 คน'),
('maintenance', '2024-12-15', 'ซ่อมแซมระบบน้ำ ชั้น 2 - งบประมาณ 2,500 บาท'),
('collection', '2024-12-20', 'สรุปการเก็บค่าเช่า - จำนวน 5 คน เก็บได้ครบ'),
('inspection', '2024-12-25', 'ตรวจสอบสภาพห้องทั้งหมด - ปกติทั้งหมด'),
('incident', '2024-12-28', 'เหตุแจ้งประกาศจากผู้เช่า ห้อง 203 - เสียงรบกวน');