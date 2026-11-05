-- A "website" link on projects and services, for one-click access from the dashboard and project pages.
ALTER TABLE projects ADD COLUMN website_url text CHECK (length(website_url) <= 500);
ALTER TABLE services ADD COLUMN website_url text CHECK (length(website_url) <= 500);
