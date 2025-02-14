function applyPagination(query, page, limit) {
    if (!page || !limit) {
        // If page and limit are not provided, return the query as is (fetch all data)
        return query;
    }
    
    const offset = (page - 1) * limit;
    return `${query} LIMIT ${limit} OFFSET ${offset}`;
}

module.exports = { applyPagination };
