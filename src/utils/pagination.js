function applyPagination(query, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    return `${query} LIMIT ${limit} OFFSET ${offset}`;
}

module.exports = applyPagination;
