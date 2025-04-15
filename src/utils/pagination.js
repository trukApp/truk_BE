function applyPagination(query, page, limit) {
    const offset = (page - 1) * limit;
    return `${query} LIMIT ${limit} OFFSET ${offset}`;
}

module.exports = applyPagination;
