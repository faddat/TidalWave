curl -H "Content-Type: application/json" -d '{"mappings": {"string":{"properties":{"userPermissions":{"type":"string", "index":"not_analyzed"},"groupPermissions":{"type":"string", "index":"not_analyzed"}}}}}' http://localhost:9200/tidalwave.pages